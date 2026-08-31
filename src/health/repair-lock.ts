/**
 * Cross-process advisory lock for launch-time stack recovery.
 *
 * Two CONTINUUM launches started back-to-back (two desktop windows, a launch
 * plus a resume) must not each fire `open -a Docker` and a `docker start`
 * storm at the same stopped stack. The first launch to reach recovery takes
 * this lock; a second launch waits for it, then re-diagnoses and uses
 * whatever state the first repair left behind instead of starting a
 * competing repair.
 *
 * Deliberately tiny: an exclusive-create lock file holding `{pid, at}`, a
 * staleness window so a crashed holder never wedges every future launch, and
 * a bounded poll. Any filesystem error degrades to "no lock" — the caller
 * then falls back to a read-only diagnose, never a crash.
 */
import { mkdirSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface RepairLockHandle {
  /** True when this process now holds the lock. */
  readonly acquired: boolean;
  /** True when the call blocked waiting for another holder (or timed out doing so). */
  readonly waited: boolean;
}

export interface RepairLock {
  acquire(waitMs: number): Promise<RepairLockHandle>;
  release(): Promise<void>;
}

/** A holder that hasn't refreshed its lock file in this long is treated as dead. */
const STALE_LOCK_MS = 15 * 60_000;
const POLL_MS = 1000;

export class FileRepairLock implements RepairLock {
  private holding = false;

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async acquire(waitMs: number): Promise<RepairLockHandle> {
    const deadline = this.now() + Math.max(0, waitMs);
    let waited = false;
    for (;;) {
      if (await this.tryCreate()) return { acquired: true, waited };
      if (await this.clearIfStale()) continue;
      if (this.now() >= deadline) return { acquired: false, waited: true };
      waited = true;
      await this.sleep(POLL_MS);
    }
  }

  async release(): Promise<void> {
    if (!this.holding) return;
    this.holding = false;
    try {
      await rm(this.file, { force: true });
    } catch {
      /* a lock we can't delete will age out via STALE_LOCK_MS */
    }
  }

  private async tryCreate(): Promise<boolean> {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const handle = await open(this.file, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now() }));
      } finally {
        await handle.close();
      }
      this.holding = true;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      // Permissions or any other unexpected error: behave as "lock unavailable"
      // so the caller degrades to diagnose-only rather than failing the launch.
      return false;
    }
  }

  private async clearIfStale(): Promise<boolean> {
    try {
      const raw = await readFile(this.file, "utf8");
      const at = Number((JSON.parse(raw) as { at?: unknown }).at);
      if (!Number.isFinite(at) || this.now() - at > STALE_LOCK_MS) {
        await rm(this.file, { force: true });
        return true;
      }
      return false;
    } catch {
      // Vanished or unreadable between checks — let the loop retry the create.
      return true;
    }
  }
}
