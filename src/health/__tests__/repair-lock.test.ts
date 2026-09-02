/**
 * FileRepairLock — the cross-process guard that stops two back-to-back
 * launches from each firing a Docker Desktop boot + `docker start` storm at
 * the same stopped stack.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { FileRepairLock } from "../repair-lock.js";

function lockFile(): string {
  return join(mkdtempSync(join(tmpdir(), "repair-lock-")), "health-repair.lock");
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock(startMs = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let nowMs = startMs;
  return { now: () => nowMs, sleep: async (ms: number) => void (nowMs += ms) };
}

describe("FileRepairLock", () => {
  it("grants the lock to the first caller and refuses a second until release", async () => {
    const file = lockFile();
    const a = new FileRepairLock(file);
    const b = new FileRepairLock(file, ...clockArgs());

    const first = await a.acquire(0);
    expect(first).toEqual({ acquired: true, waited: false });

    const blocked = await b.acquire(2_000); // fake clock: waits, then times out
    expect(blocked.acquired).toBe(false);
    expect(blocked.waited).toBe(true);

    await a.release();
    const afterRelease = await b.acquire(0);
    expect(afterRelease.acquired).toBe(true);
  });

  it("acquires once a concurrent holder releases mid-wait", async () => {
    const file = lockFile();
    const a = new FileRepairLock(file);
    await a.acquire(0);

    const clock = fakeClock();
    let released = false;
    const b = new FileRepairLock(file, clock.now, async (ms) => {
      await clock.sleep(ms);
      if (!released) {
        released = true;
        await a.release();
      }
    });

    const result = await b.acquire(60_000);
    expect(result.acquired).toBe(true);
    expect(result.waited).toBe(true);
  });

  it("steals a stale lock left by a crashed holder", async () => {
    const file = lockFile();
    writeFileSync(file, JSON.stringify({ pid: 999999, at: 1 })); // ancient timestamp

    const lock = new FileRepairLock(file, () => 100 * 60_000); // 100 minutes later
    const result = await lock.acquire(0);
    expect(result.acquired).toBe(true);

    const raw = JSON.parse(await readFile(file, "utf8")) as { pid: number };
    expect(raw.pid).toBe(process.pid);
  });

  it("release only removes a lock this instance holds", async () => {
    const file = lockFile();
    const a = new FileRepairLock(file);
    const b = new FileRepairLock(file);

    await a.acquire(0);
    await b.release(); // b never held it — must be a no-op
    expect((await a.acquire(0)).acquired).toBe(false); // a still holds it
  });

  describe("orphaned-lock robustness (a killed launch must not wedge later ones)", () => {
    const HOST = hostname();
    /** Plant a lock file as if another launch on this host wrote it. */
    function plant(file: string, atMs: number, pid = 4242): void {
      writeFileSync(file, JSON.stringify({ pid, host: HOST, at: atMs }));
    }

    it("respects a lock whose owner is still alive", async () => {
      const file = lockFile();
      plant(file, 1_000_000);
      const clock = fakeClock(1_000_000);
      const lock = new FileRepairLock(file, clock.now, clock.sleep, () => true);
      const r = await lock.acquire(4_000);
      expect(r.acquired).toBe(false);
      expect(r.waited).toBe(true);
      // owner's lock file is untouched
      expect((JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid).toBe(4242);
    });

    it("reclaims a lock whose owner process is gone — immediately, no minutes-long wait", async () => {
      const file = lockFile();
      plant(file, 1_000_000); // recent timestamp — age alone would NOT reclaim it
      const clock = fakeClock(1_000_000);
      const lock = new FileRepairLock(file, clock.now, clock.sleep, () => false); // owner dead
      const r = await lock.acquire(30_000);
      expect(r.acquired).toBe(true);
      expect(r.waited).toBe(false); // reclaimed on the first pass
      expect(clock.now() - 1_000_000).toBeLessThan(2_000); // no poll sleep happened
      expect((JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid).toBe(process.pid);
    });

    it("a stale lock does not block a launch for minutes", async () => {
      const file = lockFile();
      plant(file, 1_000_000);
      const clock = fakeClock(1_000_000);
      const lock = new FileRepairLock(file, clock.now, clock.sleep, () => false);
      await lock.acquire(30_000);
      // Real wall time would have been ~0; the fake clock proves no long sleep.
      expect(clock.now() - 1_000_000).toBeLessThan(5_000);
    });

    it("reclaims an alive-but-wedged owner past the hard ceiling", async () => {
      const file = lockFile();
      plant(file, 1_000_000);
      const clock = fakeClock(1_000_000 + 13 * 60_000); // 13 min later
      const lock = new FileRepairLock(file, clock.now, clock.sleep, () => true); // owner alive but stuck
      const r = await lock.acquire(0);
      expect(r.acquired).toBe(true);
    });

    it("emits progress while waiting on a live peer", async () => {
      const file = lockFile();
      plant(file, 1_000_000);
      const clock = fakeClock(1_000_000);
      const lock = new FileRepairLock(file, clock.now, clock.sleep, () => true);
      const lines: string[] = [];
      await lock.acquire(6_000, { onWait: (l) => lines.push(l) });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/waiting/i);
    });

    it("two concurrent acquirers never both hold it", async () => {
      const file = lockFile();
      const a = new FileRepairLock(file);
      const b = new FileRepairLock(file, ...clockArgs());
      const [ra, rb] = await Promise.all([a.acquire(0), b.acquire(1_000)]);
      expect([ra.acquired, rb.acquired].filter(Boolean)).toHaveLength(1);
    });
  });
});

function clockArgs(): [() => number, (ms: number) => Promise<void>] {
  const c = fakeClock();
  return [c.now, c.sleep];
}
