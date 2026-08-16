/**
 * Native-session id discovery — the "capture" half of the native-session
 * bridge. Read-only, best-effort, and provider-independent: it only reads the
 * `NativeSessionStore` data a profile declares; it never switches on provider
 * id and never fabricates an id.
 *
 * Three id strategies, declared by the profile:
 *   - "basename"   — filename minus extension (Claude `<uuid>.jsonl`).
 *   - "last-uuid"  — trailing UUID in the filename (Codex `rollout-…-<uuid>`).
 *   - "session-meta" — read the canonical id from a JSONL record's payload
 *     (Codex `payload.session_id`), falling back to last-uuid.
 *
 * The one deliberate heuristic is "the session file most recently created at
 * or after `sinceMs`" — after a launch, the CLI's own session store gains a
 * new file, and this returns its id. Any error yields `undefined`, which the
 * launcher treats as "no known native session" → safe fallback to the resume
 * brief. It is better to fall back than to resume the wrong conversation.
 */

import { createReadStream, promises as fsPromises } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { NativeSessionStore } from "../providers/types.js";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir → skip
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function trailingUuid(stem: string): string | undefined {
  const m = stem.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
  return m?.[1];
}

/** Read the first line of a file without loading the whole (potentially large, secret-bearing) file. */
async function readFirstLine(file: string): Promise<string | undefined> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return undefined;
}

/** Canonical id from a JSONL `session_meta` record's payload field (read-only). */
async function sessionMetaId(file: string, recordType: string | undefined, payloadField: string | undefined): Promise<string | undefined> {
  if (!recordType || !payloadField) return undefined;
  const first = await readFirstLine(file);
  if (!first) return undefined;
  try {
    const rec = JSON.parse(first) as { type?: unknown; payload?: unknown };
    if (rec.type !== recordType || typeof rec.payload !== "object" || rec.payload === null) return undefined;
    const value = (rec.payload as Record<string, unknown>)[payloadField];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function idFromFile(file: string, store: NativeSessionStore): Promise<string | undefined> {
  const stem = basename(file, extname(file));
  switch (store.idFrom) {
    case "basename":
      return stem;
    case "last-uuid":
      return trailingUuid(stem);
    case "session-meta": {
      const meta = await sessionMetaId(file, store.metaRecordType, store.metaPayloadField);
      return meta ?? trailingUuid(stem); // fall back to filename UUID if metadata unreadable
    }
  }
}

/**
 * Find the most-recent native session id in `store`, restricted to files
 * modified at/after `sinceMs`. Returns undefined when nothing qualifies.
 */
export async function findRecentNativeSessionId(
  store: NativeSessionStore,
  sinceMs = 0,
): Promise<string | undefined> {
  const root = expandHome(store.rootDir);
  const files: string[] = [];
  await walkFiles(root, files);

  let bestFile: string | undefined;
  let bestMtimeMs = -1;
  for (const file of files) {
    if (extname(file) !== store.extension) continue;
    let stat;
    try {
      stat = await fsPromises.stat(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < sinceMs) continue;
    if (stat.mtimeMs > bestMtimeMs) {
      bestMtimeMs = stat.mtimeMs;
      bestFile = file;
    }
  }
  if (!bestFile) return undefined;
  return idFromFile(bestFile, store);
}
