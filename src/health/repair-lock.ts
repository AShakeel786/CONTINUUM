/**
 * Cross-process advisory lock for launch-time stack recovery.
 *
 * Two CONTINUUM launches started back-to-back (two desktop windows, a launch
 * plus a resume) must not each fire `open -a Docker` and a `docker start`
 * storm at the same stopped stack. The first launch to reach recovery takes
 * this lock; a second launch waits briefly, then re-diagnoses and uses
 * whatever state the first repair left behind instead of racing its own.
 *
 * Robustness rules (a killed launch must not wedge every later one):
 *   - The lock file records `{pid, host, at}`. On contention the holder's
 *     liveness is checked directly (`process.kill(pid, 0)`): a holder whose
 *     process is gone on this machine is reclaimed IMMEDIATELY — no minutes-
 *     long age wait.
 *   - An *alive* holder on this host is respected until a hard ceiling
 *     (`HELD_HARD_CEILING_MS`) that the full repair cascade cannot legitimately
 *     exceed; past it the holder is treated as wedged and reclaimed.
 *   - A holder on a different host (can't probe its pid) falls back to a
 *     moderate age threshold.
 *   - A short bounded `acquire` wait (the caller passes ~30s) with a progress
 *     callback, so a second launch never silently freezes for minutes.
 *   - Normal / error release goes through `release()` in the caller's
 *     `finally`; `process.exit` / fall-through is covered by a synchronous
 *     `exit` handler; SIGINT/SIGTERM by a handler that removes the file then
 *     re-raises. SIGKILL / hard crash is covered by the pid reclaim above.
 *
 * Any filesystem error degrades to "lock unavailable" — the caller then falls
 * back to a read-only diagnose, never a crash.
 */
import { mkdirSync, rmSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface RepairLockHandle {
  /** True when this process now holds the lock. */
  readonly acquired: boolean;
  /** True when the call blocked waiting for another holder (or timed out doing so). */
  readonly waited: boolean;
}

export interface AcquireOptions {
  /** Emitted roughly every poll while blocked on another launch's repair. */
  readonly onWait?: (line: string) => void;
}

export interface RepairLock {
  acquire(waitMs: number, opts?: AcquireOptions): Promise<RepairLockHandle>;
  release(): Promise<void>;
}

interface LockPayload {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
}

/**
 * An alive holder on THIS host is respected until this ceiling. The full
 * cascade — Docker Desktop cold boot (≤180s) + container health waits
 * (≤3×60s) + a canonical start script (≤180s) + re-diagnoses — cannot
 * legitimately run longer, so a lock older than this is a wedged holder.
 */
const HELD_HARD_CEILING_MS = 12 * 60_000;
/** Holder on another host — pid can't be probed, so fall back to age. */
const CROSS_HOST_STALE_MS = 3 * 60_000;
const POLL_MS = 2_000;

const CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Is `pid` a live process? `EPERM` = it exists but is not ours (still alive). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FileRepairLock implements RepairLock {
  private holding = false;
  private disarm?: () => void;

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Injectable liveness probe (tests). Default: same host + live pid. */
    private readonly holderAlive: (payload: LockPayload) => boolean = (p) => p.host === hostname() && pidAlive(p.pid),
  ) {}

  async acquire(waitMs: number, opts: AcquireOptions = {}): Promise<RepairLockHandle> {
    const startedAt = this.now();
    const deadline = startedAt + Math.max(0, waitMs);
    let waited = false;
    for (;;) {
      if (await this.tryCreate()) return { acquired: true, waited };
      if (await this.reclaimIfDead()) continue;
      if (this.now() >= deadline) return { acquired: false, waited: true };
      waited = true;
      opts.onWait?.(`another launch is recovering the stack — waiting… (${Math.round((this.now() - startedAt) / 1000)}s)`);
      await this.sleep(POLL_MS);
    }
  }

  async release(): Promise<void> {
    this.disarm?.();
    this.disarm = undefined;
    if (!this.holding) return;
    this.holding = false;
    try {
      await rm(this.file, { force: true });
    } catch {
      /* a lock we cannot delete is reclaimed by the next launch's pid check */
    }
  }

  private async tryCreate(): Promise<boolean> {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const handle = await open(this.file, "wx");
      try {
        const payload: LockPayload = { pid: process.pid, host: hostname(), at: this.now() };
        await handle.writeFile(JSON.stringify(payload));
      } finally {
        await handle.close();
      }
      this.holding = true;
      this.arm();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      // Permissions or any other unexpected error: behave as "lock unavailable"
      // so the caller degrades to diagnose-only rather than failing the launch.
      return false;
    }
  }

  /** Reclaim the lock file when its holder is provably gone (or wedged). */
  private async reclaimIfDead(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return true; // vanished between checks — retry create
    }
    let payload: Partial<LockPayload> | undefined;
    if (raw.trim().length > 0) {
      try {
        payload = JSON.parse(raw) as Partial<LockPayload>;
      } catch {
        payload = undefined;
      }
    }
    if (!payload) {
      // Empty or not-yet-parseable: almost always a lock file a competing
      // acquirer just `open("wx")`d and has not written its `{pid,host,at}`
      // into yet. Do NOT delete it (that would let two acquirers each think
      // they hold it) and do NOT report it retriable (that spins the acquire
      // loop). Treat it like a live holder: fall through to the bounded wait.
      return false;
    }
    const at = Number(payload.at);
    const full: LockPayload = {
      pid: Number(payload.pid),
      host: typeof payload.host === "string" ? payload.host : "",
      at,
    };
    const ageMs = Number.isFinite(at) ? this.now() - at : Infinity;

    let dead: boolean;
    if (!Number.isFinite(at)) {
      dead = true;
    } else if (full.host === hostname()) {
      dead = !this.holderAlive(full) || ageMs > HELD_HARD_CEILING_MS;
    } else {
      dead = ageMs > CROSS_HOST_STALE_MS;
    }
    return dead ? this.forceRemove() : false;
  }

  private async forceRemove(): Promise<boolean> {
    try {
      await rm(this.file, { force: true });
    } catch {
      /* another launch won the reclaim race — the loop retries create */
    }
    return true;
  }

  /**
   * Best-effort synchronous cleanup for the paths a `finally` cannot reach:
   * `process.exit` / event-loop drain (`exit`) and Ctrl-C / `kill`
   * (SIGINT/SIGTERM/SIGHUP). NOT the primary guarantee — SIGKILL and hard
   * crashes are handled by the next launch's pid-liveness reclaim.
   */
  private arm(): void {
    if (this.disarm) return;
    const remove = (): void => {
      try {
        rmSync(this.file, { force: true });
      } catch {
        /* best effort */
      }
    };
    const onExit = (): void => {
      if (this.holding) remove();
    };
    const onSignal = (sig: NodeJS.Signals): void => {
      if (this.holding) {
        this.holding = false;
        remove();
      }
      cleanup();
      // Re-raise with the default disposition so we don't swallow the signal.
      process.kill(process.pid, sig);
    };
    const cleanup = (): void => {
      process.removeListener("exit", onExit);
      for (const sig of CLEANUP_SIGNALS) process.removeListener(sig, onSignal);
    };
    process.once("exit", onExit);
    for (const sig of CLEANUP_SIGNALS) process.once(sig, onSignal);
    this.disarm = cleanup;
  }
}
