import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "../build.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "session-write-"));
}

async function setup() {
  const dir = tmp();
  const registry = await buildToolRegistry({ dataDir: dir, memoryProvider: async () => undefined });
  const manager = new SessionManager(new FileSessionStore(join(dir, "sessions")));
  await manager.createSession({
    sessionId: "sess-1",
    projectId: "p",
    workingDirectory: "/w",
    activeProvider: { providerId: "claude", model: "m" },
    taskGoal: "task",
  });
  return { registry, manager };
}

describe("session_update MCP write tool", () => {
  it("is classified as a write tool", async () => {
    const { registry } = await setup();
    const def = registry.definition("session_update");
    expect(def).toBeDefined();
    expect(def!.access).toBe("write");
  });

  it("records completed/remaining work, decisions, files, and tool activity", async () => {
    const { registry, manager } = await setup();
    await registry.call("session_update", { sessionId: "sess-1", op: "complete_work", description: "Wired the launcher" });
    await registry.call("session_update", { sessionId: "sess-1", op: "add_remaining_work", description: "Write regression tests" });
    await registry.call("session_update", { sessionId: "sess-1", op: "record_decision", decision: "Use FileSessionStore", rationale: "no DB needed" });
    await registry.call("session_update", { sessionId: "sess-1", op: "record_relevant_file", path: "src/session/store.ts", note: "durable backend" });
    await registry.call("session_update", { sessionId: "sess-1", op: "record_tool_activity", tool: "Edit", summary: "modified store.ts" });

    const s = await manager.loadSession("sess-1");
    expect(s.completedWork.map((w) => w.description)).toEqual(["Wired the launcher"]);
    expect(s.remainingWork.map((w) => w.description)).toEqual(["Write regression tests"]);
    expect(s.importantDecisions.map((d) => d.decision)).toEqual(["Use FileSessionStore"]);
    expect(s.importantDecisions[0]!.rationale).toBe("no DB needed");
    expect(s.relevantFiles.map((f) => f.path)).toEqual(["src/session/store.ts"]);
    expect(s.recentToolActivity.map((a) => `${a.tool}:${a.summary}`)).toEqual(["Edit:modified store.ts"]);
  });

  it("dedupes identical completed work and decisions", async () => {
    const { registry, manager } = await setup();
    await registry.call("session_update", { sessionId: "sess-1", op: "complete_work", description: "Done X" });
    await registry.call("session_update", { sessionId: "sess-1", op: "complete_work", description: "  done x  " });
    await registry.call("session_update", { sessionId: "sess-1", op: "record_decision", decision: "Use A" });
    await registry.call("session_update", { sessionId: "sess-1", op: "record_decision", decision: "use a" });

    const s = await manager.loadSession("sess-1");
    expect(s.completedWork).toHaveLength(1);
    expect(s.importantDecisions).toHaveLength(1);
  });

  it("rejects invalid or missing inputs and unknown sessions", async () => {
    const { registry } = await setup();
    expect((await registry.call("session_update", { sessionId: "sess-1", op: "complete_work" })).isError).toBe(true);
    expect((await registry.call("session_update", { sessionId: "sess-1", op: "nonsense" })).isError).toBe(true);
    expect((await registry.call("session_update", { sessionId: "missing", op: "complete_work", description: "x" })).isError).toBe(true);
    const overlong = "x".repeat(5000);
    expect((await registry.call("session_update", { sessionId: "sess-1", op: "complete_work", description: overlong })).isError).toBe(true);
  });

  it("does not expose credentials or raw output in results", async () => {
    const { registry } = await setup();
    const res = await registry.call("session_update", { sessionId: "sess-1", op: "record_decision", decision: "Use A", rationale: "sk-secret-should-not-leak" });
    expect(JSON.stringify(res)).not.toContain("sk-secret-should-not-leak");
  });
});
