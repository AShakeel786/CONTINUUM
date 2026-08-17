import { describe, expect, it } from "vitest";
import { buildSessionMaintenanceBlock } from "../resume-block.js";
import type { TaskSession } from "../../session/types.js";

function session(): TaskSession {
  return {
    schemaVersion: 1,
    sessionId: "sess-abc",
    revision: 1,
    projectId: "p",
    mode: "project",
    workingDirectory: "/w",
    activeProvider: { providerId: "claude", model: "m" },
    taskGoal: "goal",
    status: "active",
    completedWork: [],
    remainingWork: [],
    importantDecisions: [],
    relevantFiles: [],
    recentToolActivity: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

describe("buildSessionMaintenanceBlock", () => {
  it("is an instructions block that names the session and the write tool", () => {
    const block = buildSessionMaintenanceBlock(session());
    expect(block.class).toBe("instructions");
    expect(block.id).toBe("handoff:session-maintenance");
    expect(block.content).toContain("sess-abc");
    expect(block.content).toContain("session_update");
    expect(block.content).toContain("complete_work");
    expect(block.content).toContain("record_decision");
    expect(block.content).toContain("record_relevant_file");
  });

  it("is compact (does not burn a large token budget)", () => {
    const block = buildSessionMaintenanceBlock(session());
    expect(block.content.split("\n").length).toBeLessThanOrEqual(10);
    expect(block.content.length).toBeLessThan(700);
  });
});
