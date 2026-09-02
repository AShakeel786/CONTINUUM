/**
 * Persisted managed-service state + process-liveness + startup dedupe lock.
 *
 * State file: `<dataDir>/local-services/<providerId>.json` — the record of a
 * server CONTINUUM spawned (pid, host:port, command, log path). Its mere
 * existence is the ownership claim; `continuum local stop` only ever acts on
 * a process named here whose pid is still alive AND still the same program.
 *
 * Lock file: `<dataDir>/local-services/<providerId>.lock` — created O_EXCL so
 * two concurrent `continuum` invocations cannot both spawn the same server.
 * A lock whose writer pid is dead, or that is older than the startup budget,
 * is considered abandoned and is broken.
 *
 * Stale recovery: a state file left behind by a crash or reboot points at a
 * pid that is either dead or has been recycled to an unrelated program.
 * `readLiveState` returns such a file as `stale` so the caller clears it and
 * starts fresh instead of trusting a phantom pid.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { LocalServiceState } from "./types.js";

export function localServicesDir(dataDir: string): string {
  return join(dataDir, "local-services");
}

export function stateFilePath(dataDir: string, providerId: string): string {
  return join(localServicesDir(dataDir), `${providerId}.json`);
}

export function lockFilePath(dataDir: string, providerId: string): string {
  return join(localServicesDir(dataDir), `${providerId}.lock`);
}

export function logFilePath(dataDir: string, providerId: string): string {
  return join(localServicesDir(dataDir), `${providerId}.log`);
}

/** Signal 0 = "does a process with this pid exist and can we address it?" — never actually signals. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is owned by someone else — still "alive".
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writeState(dataDir: string, state: LocalServiceState): Promise<void> {
  const dir = localServicesDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = stateFilePath(dataDir, state.providerId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

export async function readState(dataDir: string, providerId: string): Promise<LocalServiceState | undefined> {
  try {
    const raw = await fs.readFile(stateFilePath(dataDir, providerId), "utf8");
    const parsed = JSON.parse(raw) as LocalServiceState;
    if (parsed && parsed.schemaVersion === 1 && typeof parsed.pid === "number" && parsed.ownedByContinuum === true) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function clearState(dataDir: string, providerId: string): Promise<void> {
  await fs.rm(stateFilePath(dataDir, providerId), { force: true });
}

export interface LiveStateResult {
  /** The persisted state, if a file exists. */
  readonly state?: LocalServiceState;
  /** The pid named in the file is alive. */
  readonly pidAlive: boolean;
  /**
   * The file exists but its pid is dead (crash/reboot) — the caller should
   * clear it and not trust the pid.
   */
  readonly stale: boolean;
}

export async function readLiveState(dataDir: string, providerId: string): Promise<LiveStateResult> {
  const state = await readState(dataDir, providerId);
  if (!state) return { pidAlive: false, stale: false };
  const pidAlive = isPidAlive(state.pid);
  return { state, pidAlive, stale: !pidAlive };
}

// ── startup dedupe lock ────────────────────────────────────────────────

interface LockPayload {
  readonly pid: number;
  readonly at: string;
}

/**
 * Try to acquire the per-provider startup lock. Returns a release function on
 * success, or `undefined` when another live invocation holds it. An abandoned
 * lock (dead writer, or older than `maxAgeMs`) is broken and re-acquired.
 */
export async function acquireStartupLock(
  dataDir: string,
  providerId: string,
  opts: { maxAgeMs?: number } = {},
): Promise<(() => Promise<void>) | undefined> {
  const dir = localServicesDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = lockFilePath(dataDir, providerId);
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
  const payload: LockPayload = { pid: process.pid, at: new Date().toISOString() };

  const tryCreate = async (): Promise<boolean> => {
    try {
      await fs.writeFile(file, JSON.stringify(payload), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    }
  };

  if (await tryCreate()) return () => fs.rm(file, { force: true });

  // Lock exists — is it abandoned?
  let holder: LockPayload | undefined;
  try {
    holder = JSON.parse(await fs.readFile(file, "utf8")) as LockPayload;
  } catch {
    holder = undefined;
  }
  const holderDead = !holder || !isPidAlive(holder.pid);
  const holderStale = holder ? Date.now() - Date.parse(holder.at) > maxAgeMs : true;
  if (holderDead || holderStale) {
    await fs.rm(file, { force: true });
    if (await tryCreate()) return () => fs.rm(file, { force: true });
  }
  return undefined;
}
