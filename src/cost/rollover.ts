import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { captureGitFingerprint } from "../session/git-fingerprint.js";
import type { TaskSession } from "../session/types.js";

function bullets(items: readonly string[]): string { return items.length ? items.map((x) => `- ${x}`).join("\n") : "- None recorded"; }

export async function createRolloverHandoff(dataDir: string, session: TaskSession, reason: string) {
  const rolloverId = randomUUID();
  const git = session.mode === "general" ? undefined : await captureGitFingerprint(session.workingDirectory);
  const text = [
    "# CONTINUUM native-session rollover handoff", "", `Logical session: ${session.sessionId}`, `Project: ${session.projectId ?? session.mode}`, `Objective: ${session.taskGoal}`, "",
    "## Decisions and constraints", bullets(session.importantDecisions.map((d) => `${d.decision}${d.rationale ? ` — ${d.rationale}` : ""}`)), "",
    "## Modified/relevant files", bullets(session.relevantFiles.map((f) => `${f.path}${f.note ? ` — ${f.note}` : ""}`)), "",
    "## Completed work / tests", bullets(session.completedWork.map((w) => w.description)), "",
    "## Unresolved issues / TODO", bullets(session.remainingWork.map((w) => w.description)), "",
    "## Git state", git ? bullets([`branch: ${git.branch ?? "unknown"}`, `HEAD: ${git.headSha ?? "unknown"}`, `dirty: ${git.dirty}`, git.changedFileSummary]) : "- Not anchored to a repository", "",
    "## Rollover", reason, "The prior native transcript is preserved and may be resumed using the audit record. Do not discard uncommitted work.", "",
  ].join("\n");
  const dir = join(dataDir, "rollovers", session.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${rolloverId}.md`);
  await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { rolloverId, file, text, git };
}
