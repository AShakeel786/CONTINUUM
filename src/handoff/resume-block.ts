/**
 * Builds the resume-instructions content block a receiving agent sees.
 * Deliberately an "instructions"-class ContextBlock — that's what makes it
 * automatically protected from Token Manager trimming (context/types.ts's
 * `isStableClass`/budget.ts's exemption), without any handoff-specific
 * budgeting logic. Content matches the brief's explicit list item-for-item
 * (§5 "Resume Semantics").
 */

import type { ContextBlock } from "../context/types.js";
import type { FingerprintComparison } from "../session/git-fingerprint.js";
import type { TaskSession } from "../session/types.js";

export function buildResumeInstructionsBlock(session: TaskSession, staleness: FingerprintComparison): ContextBlock {
  const lines: string[] = [
    "<handoff-resume>",
    "This is an EXISTING task, already in progress. Do not re-audit the project from scratch.",
    "",
    `## Objective`,
    session.taskGoal,
    "",
  ];

  if (session.completedWork.length > 0) {
    lines.push("## Already completed", ...session.completedWork.map((w) => `- ${w.description}`), "");
  } else {
    lines.push("## Already completed", "(nothing recorded yet)", "");
  }

  if (session.remainingWork.length > 0) {
    lines.push("## Remaining", ...session.remainingWork.map((w) => `- ${w.description}`), "");
  } else {
    lines.push("## Remaining", "(nothing outstanding recorded — verify with the user before assuming the task is done)", "");
  }

  if (session.importantDecisions.length > 0) {
    lines.push(
      "## Decisions already made — do not re-litigate these without new evidence",
      ...session.importantDecisions.map((d) => `- ${d.decision}${d.rationale ? ` (${d.rationale})` : ""}`),
      "",
    );
  }

  if (session.relevantFiles.length > 0) {
    lines.push(
      "## Relevant files",
      ...session.relevantFiles.map((f) => `- \`${f.path}\`${f.note ? ` — ${f.note}` : ""}`),
      "",
    );
  }

  lines.push("## Repo/worktree status at handoff time", session.git ? formatGitSummary(session.git) : "(not captured)", "");

  if (staleness.stale) {
    lines.push(
      "## ⚠️ STALE STATE WARNING",
      "The repository has changed since this session's state was last recorded:",
      ...staleness.reasons.map((r) => `- ${r}`),
      "Verify current repo state before continuing. Do not assume continuity is exact — reconcile first.",
      "",
    );
  } else {
    lines.push("## Repo state check", "No material drift detected since state was last recorded.", "");
  }

  if (session.recentToolActivity.length > 0) {
    lines.push(
      "## Recent tool activity (most recent last)",
      ...session.recentToolActivity.map((a) => `- [${a.tool}] ${a.summary}`),
      "",
    );
  }

  lines.push("</handoff-resume>");

  return {
    id: "handoff:resume-instructions",
    class: "instructions",
    content: lines.join("\n"),
    priority: 0,
    provenance: { source: "handoff-manager", fetchedAt: new Date().toISOString() },
  };
}

function formatGitSummary(git: NonNullable<TaskSession["git"]>): string {
  const parts = [
    git.branch ? `branch=${git.branch}` : undefined,
    git.headSha ? `HEAD=${git.headSha.slice(0, 12)}` : undefined,
    `status=${git.dirty ? git.changedFileSummary : "clean"}`,
  ].filter(Boolean);
  return parts.join(", ") || "(unknown)";
}
