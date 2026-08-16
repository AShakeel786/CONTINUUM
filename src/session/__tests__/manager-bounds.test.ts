import { afterEach, describe, expect, it } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSessionStore } from "../store.js";
import { SessionManager } from "../manager.js";

let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "continuum-manager-bounds-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fsPromises.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeManager(): Promise<SessionManager> {
  const manager = new SessionManager(new FileSessionStore(await makeTmpDir()));
  await manager.createSession({
    sessionId: "sess-1",
    projectId: "p",
    workingDirectory: "/w",
    activeProvider: { providerId: "claude", model: "m" },
    taskGoal: "goal",
  });
  return manager;
}

describe("SessionManager bounds and deduplication", () => {
  it("dedupes completed and remaining work by normalized description", async () => {
    const manager = await makeManager();
    await manager.addCompletedWork("sess-1", "Did X");
    await manager.addCompletedWork("sess-1", "  DID x ");
    await manager.addRemainingWork("sess-1", "Todo Y");
    await manager.addRemainingWork("sess-1", "todo y");

    const s = await manager.loadSession("sess-1");
    expect(s.completedWork.map((w) => w.description)).toEqual(["Did X"]);
    expect(s.remainingWork.map((w) => w.description)).toEqual(["Todo Y"]);
  });

  it("bounds completedWork to the most recent 50 entries", async () => {
    const manager = await makeManager();
    for (let i = 0; i < 55; i++) await manager.addCompletedWork("sess-1", `item ${i}`);
    const s = await manager.loadSession("sess-1");
    expect(s.completedWork).toHaveLength(50);
    expect(s.completedWork[0]!.description).toBe("item 5");
    expect(s.completedWork[49]!.description).toBe("item 54");
  });

  it("ignores empty writes rather than recording blanks", async () => {
    const manager = await makeManager();
    await manager.addCompletedWork("sess-1", "   ");
    await manager.recordDecision("sess-1", "");
    await manager.recordRelevantFile("sess-1", "  ");
    const s = await manager.loadSession("sess-1");
    expect(s.completedWork).toHaveLength(0);
    expect(s.importantDecisions).toHaveLength(0);
    expect(s.relevantFiles).toHaveLength(0);
  });
});
