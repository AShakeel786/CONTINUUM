import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { cleanupSmokeSessions, isSmokeSession, listSessions } from "../session-list.js";
import type { TaskSession } from "../../session/types.js";

function makeSession(partial: Partial<TaskSession>): TaskSession {
  return {
    schemaVersion: 1,
    sessionId: "s1",
    revision: 1,
    projectId: "p",
    workingDirectory: "/w",
    activeProvider: { providerId: "codex", model: "m" },
    taskGoal: "fix it",
    status: "active",
    completedWork: [],
    remainingWork: [],
    importantDecisions: [],
    relevantFiles: [],
    recentToolActivity: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("isSmokeSession", () => {
  it("flags a trivial empty/untitled goal with no recorded work", () => {
    expect(isSmokeSession(makeSession({ taskGoal: "(untitled)" }))).toBe(true);
    expect(isSmokeSession(makeSession({ taskGoal: "" }))).toBe(true);
  });

  it("flags an explicitly test-shaped goal with no recorded work", () => {
    expect(isSmokeSession(makeSession({ taskGoal: "smoke test run" }))).toBe(true);
    expect(isSmokeSession(makeSession({ taskGoal: "daily workflow check" }))).toBe(true);
  });

  it("never flags a session with recorded work (real work)", () => {
    expect(
      isSmokeSession(makeSession({ taskGoal: "smoke test", completedWork: [{ id: "w", description: "did something", recordedAt: "x" }] })),
    ).toBe(false);
  });

  it("never flags a normal goal with no work (e.g. a fresh real task)", () => {
    expect(isSmokeSession(makeSession({ taskGoal: "fix the login bug" }))).toBe(false);
  });
});

describe("listSessions + cleanupSmokeSessions", () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "cont-sess-life-"));
    const store = new FileSessionStore(dir);
    const manager = new SessionManager(store);
    await manager.createSession({ sessionId: "active-1", projectId: "p", workingDirectory: "/w", activeProvider: { providerId: "codex", model: "m" }, taskGoal: "fix the bug" });
    await manager.createSession({ sessionId: "smoke-1", projectId: "p", workingDirectory: "/w", activeProvider: { providerId: "codex", model: "m" }, taskGoal: "smoke test" });
    await manager.createSession({ sessionId: "done-1", projectId: "p", workingDirectory: "/w", activeProvider: { providerId: "codex", model: "m" }, taskGoal: "write tests" });
    await manager.setStatus("done-1", "completed");
    return manager;
  }

  it("listSessions filters active vs archived vs all", async () => {
    const manager = await setup();
    const active = await listSessions(manager, "active", 20);
    expect(active.map((s) => s.sessionId).sort()).toEqual(["active-1", "smoke-1"]);
    const archived = await listSessions(manager, "archived", 20);
    expect(archived.map((s) => s.sessionId)).toEqual(["done-1"]);
    const all = await listSessions(manager, "all", 20);
    expect(all).toHaveLength(3);
  });

  it("cleanupSmokeSessions deletes only smoke sessions, never real work", async () => {
    const manager = await setup();
    const dry = await cleanupSmokeSessions(manager, true);
    expect(dry).toEqual(["smoke-1"]);
    // Dry-run did not delete.
    expect((await listSessions(manager, "all", 20))).toHaveLength(3);

    const removed = await cleanupSmokeSessions(manager, false);
    expect(removed).toEqual(["smoke-1"]);
    const remaining = await listSessions(manager, "all", 20);
    expect(remaining.map((s) => s.sessionId).sort()).toEqual(["active-1", "done-1"]);
  });
});
