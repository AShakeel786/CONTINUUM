import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRolloverHandoff } from "../rollover.js";
import type { TaskSession } from "../../session/types.js";
it("preserves handoff state and lineage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuum-rollover-"));
  const session: TaskSession = { schemaVersion: 1, sessionId: "logical-1", revision: 1, mode: "current-directory", workingDirectory: dir, activeProvider: { providerId: "deepseek", model: "deepseek-v4-flash" }, taskGoal: "ship safely", status: "active", completedWork: [{ id: "c", description: "tests pass", recordedAt: "x" }], remainingWork: [{ id: "r", description: "build", recordedAt: "x" }], importantDecisions: [{ id: "d", decision: "no deletion", recordedAt: "x" }], relevantFiles: [{ path: "src/a.ts", note: "changed", recordedAt: "x" }], recentToolActivity: [], createdAt: "x", updatedAt: "x" };
  const result = await createRolloverHandoff(dir, session, "threshold reached");
  const text = await readFile(result.file, "utf8");
  for (const expected of ["logical-1", "ship safely", "no deletion", "src/a.ts", "tests pass", "build", "Git state", "threshold reached"]) expect(text).toContain(expected);
});
