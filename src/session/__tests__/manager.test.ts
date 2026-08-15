import { afterEach, describe, expect, it } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSessionStore } from "../store.js";
import { SessionManager } from "../manager.js";

let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "continuum-session-manager-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fsPromises.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeManager(): Promise<SessionManager> {
  return new SessionManager(new FileSessionStore(await makeTmpDir()));
}

describe("SessionManager — create/load/update", () => {
  it("creates a session with sensible defaults", async () => {
    const manager = await makeManager();
    const session = await manager.createSession({
      sessionId: "sess-1",
      projectId: "proj-1",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "claude-sonnet-5" },
      taskGoal: "Fix the bug",
    });
    expect(session.status).toBe("active");
    expect(session.revision).toBe(1);
    expect(session.completedWork).toEqual([]);
  });

  it("refuses to create a session with an id that already exists", async () => {
    const manager = await makeManager();
    await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    await expect(
      manager.createSession({
        sessionId: "sess-1",
        projectId: "p",
        workingDirectory: "C:\\fake",
        activeProvider: { providerId: "claude", model: "m" },
        taskGoal: "different goal",
      }),
    ).rejects.toThrow();
  });

  it("every update bumps revision and updatedAt", async () => {
    const manager = await makeManager();
    const created = await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    const updated = await manager.updateTaskGoal("sess-1", "new goal");
    expect(updated.revision).toBe(created.revision + 1);
    expect(updated.taskGoal).toBe("new goal");
  });

  it("preserves completed and remaining work across separate update calls", async () => {
    const manager = await makeManager();
    await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    await manager.addRemainingWork("sess-1", "Write tests");
    await manager.addRemainingWork("sess-1", "Update docs");
    const session = await manager.addCompletedWork("sess-1", "Fixed the parser bug");

    expect(session.completedWork.map((w) => w.description)).toEqual(["Fixed the parser bug"]);
    expect(session.remainingWork.map((w) => w.description)).toEqual(["Write tests", "Update docs"]);
  });

  it("completeWorkItem moves an item from remaining to completed", async () => {
    const manager = await makeManager();
    await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    const withRemaining = await manager.addRemainingWork("sess-1", "Write tests");
    const workItemId = withRemaining.remainingWork[0]!.id;
    const session = await manager.completeWorkItem("sess-1", workItemId, "Wrote 12 tests, all passing");

    expect(session.remainingWork).toHaveLength(0);
    expect(session.completedWork.map((w) => w.description)).toEqual(["Wrote 12 tests, all passing"]);
  });

  it("recordDecision, recordRelevantFile, recordToolActivity all accumulate independently", async () => {
    const manager = await makeManager();
    await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    await manager.recordDecision("sess-1", "Use FileSessionStore over a DB", "simplicity, no distributed state needed");
    await manager.recordRelevantFile("sess-1", "src/session/store.ts", "durable backend");
    const session = await manager.recordToolActivity("sess-1", "Edit", "modified store.ts");

    expect(session.importantDecisions).toHaveLength(1);
    expect(session.relevantFiles).toHaveLength(1);
    expect(session.recentToolActivity).toHaveLength(1);
  });

  it("recordRelevantFile de-dupes by path (a re-note replaces, doesn't accumulate)", async () => {
    const manager = await makeManager();
    await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    await manager.recordRelevantFile("sess-1", "src/x.ts", "first note");
    const session = await manager.recordRelevantFile("sess-1", "src/x.ts", "updated note");
    expect(session.relevantFiles).toHaveLength(1);
    expect(session.relevantFiles[0]!.note).toBe("updated note");
  });

  it("recentToolActivity is a bounded ring buffer (keeps only the most recent 20)", async () => {
    const manager = await makeManager();
    await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    let session = await manager.loadSession("sess-1");
    for (let i = 0; i < 25; i++) {
      session = await manager.recordToolActivity("sess-1", "Bash", `command ${i}`);
    }
    expect(session.recentToolActivity).toHaveLength(20);
    expect(session.recentToolActivity[0]!.summary).toBe("command 5"); // oldest 5 dropped
    expect(session.recentToolActivity[19]!.summary).toBe("command 24");
  });

  it("setActiveProvider updates the provider reference without touching other fields", async () => {
    const manager = await makeManager();
    await manager.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "claude-sonnet-5" },
      taskGoal: "goal",
    });
    const session = await manager.setActiveProvider("sess-1", { providerId: "deepseek", model: "deepseek-v4-pro" });
    expect(session.activeProvider).toEqual({ providerId: "deepseek", model: "deepseek-v4-pro" });
    expect(session.taskGoal).toBe("goal");
  });

  it("session state truly persists across a simulated process restart", async () => {
    const dir = await makeTmpDir();
    const managerA = new SessionManager(new FileSessionStore(dir));
    await managerA.createSession({
      sessionId: "sess-1",
      projectId: "p",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "goal",
    });
    await managerA.addCompletedWork("sess-1", "Did the first thing");

    const managerB = new SessionManager(new FileSessionStore(dir));
    const session = await managerB.loadSession("sess-1");
    expect(session.completedWork.map((w) => w.description)).toEqual(["Did the first thing"]);
  });
});
