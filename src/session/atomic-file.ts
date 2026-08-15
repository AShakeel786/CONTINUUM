/**
 * Generic atomic-write-with-corruption-recovery file primitive. Not
 * session-specific — `store.ts` is the only caller today, but nothing here
 * assumes a `TaskSession` shape.
 *
 * Write path: write to a uniquely-named temp file in the same directory
 * (same filesystem, so the final rename is atomic), fsync it, copy the
 * *current* file to `.bak` (best-effort — a missing current file is fine,
 * anything else is a real error), then rename the temp file over the
 * target. A reader never observes a partially-written file: either the old
 * version or the new one, never a truncated in-between state.
 *
 * Read path: verify a checksum computed over the canonical (key-sorted)
 * form of the stored data. On mismatch, fall back to `.bak`. If both are
 * unreadable/corrupt, throw `SessionCorruptionError` — never silently
 * return a default/empty value, which would hide real data loss.
 */

import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "./canonical-json.js";
import { SessionCorruptionError } from "./errors.js";

interface StoredEnvelope<T> {
  readonly checksum: string;
  readonly data: T;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export async function atomicWriteJson<T>(filePath: string, data: T): Promise<void> {
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });

  const checksum = sha256(canonicalStringify(data));
  const envelope: StoredEnvelope<T> = { checksum, data };
  const payload = JSON.stringify(envelope, null, 2);

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const handle = await fsPromises.open(tmpPath, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fsPromises.copyFile(filePath, `${filePath}.bak`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await fsPromises.rename(tmpPath, filePath);
}

async function readAndVerify<T>(filePath: string): Promise<T> {
  const raw = await fsPromises.readFile(filePath, "utf8");
  const envelope = JSON.parse(raw) as StoredEnvelope<T>;
  const expected = sha256(canonicalStringify(envelope.data));
  if (expected !== envelope.checksum) {
    throw new Error(`checksum mismatch: expected ${expected}, stored envelope claims ${envelope.checksum}`);
  }
  return envelope.data;
}

export interface RecoveredRead<T> {
  readonly data: T;
  readonly recoveredFromBackup: boolean;
}

/** Throws SessionCorruptionError if neither the primary file nor its `.bak` verify. Assumes the primary file exists (callers check existence first — see store.ts's distinct "not found" handling). */
export async function readJsonWithRecovery<T>(filePath: string): Promise<RecoveredRead<T>> {
  try {
    return { data: await readAndVerify<T>(filePath), recoveredFromBackup: false };
  } catch (primaryErr) {
    try {
      const data = await readAndVerify<T>(`${filePath}.bak`);
      return { data, recoveredFromBackup: true };
    } catch (backupErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const backupMsg = backupErr instanceof Error ? backupErr.message : String(backupErr);
      throw new SessionCorruptionError(filePath, `primary: ${primaryMsg}; backup: ${backupMsg}`);
    }
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
