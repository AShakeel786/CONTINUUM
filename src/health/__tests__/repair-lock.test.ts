/**
 * FileRepairLock — the cross-process guard that stops two back-to-back
 * launches from each firing a Docker Desktop boot + `docker start` storm at
 * the same stopped stack.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
});

function clockArgs(): [() => number, (ms: number) => Promise<void>] {
  const c = fakeClock();
  return [c.now, c.sleep];
}
