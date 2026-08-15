/**
 * `continuum sessions [list] [--limit N]` and `continuum sessions archive
 * [--older-than ISO]` — recent-session listing and cleanup so a user never
 * has to recall a session id.
 */

import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { listRecentSessions, archiveFinishedSessions } from "../../launcher/session-list.js";
import type { CliIo } from "../index.js";
import { buildLauncherContext } from "./launcher-context.js";

function opt(args: readonly string[], ...flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]!) && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

export async function runSessionsCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const { sessionManager } = await buildLauncherContext({ prompt: createPrompt() });

  const [sub, ...rest] = args;

  if (sub === "archive") {
    const olderThan = opt(rest, "--older-than") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const archived = await archiveFinishedSessions(sessionManager, olderThan);
    out(`Archived ${archived.length} finished session${archived.length === 1 ? "" : "s"}.\n`);
    return 0;
  }

  // Default: list.
  const limit = Number(opt(rest, "--limit") ?? "20");
  const sessions = await listRecentSessions(sessionManager, Number.isFinite(limit) ? limit : 20);
  if (sessions.length === 0) {
    out("No sessions yet.\n");
    return 0;
  }
  for (const s of sessions) {
    const goal = s.taskGoal.length > 60 ? `${s.taskGoal.slice(0, 57)}…` : s.taskGoal;
    out(`- ${s.sessionId}  [${s.providerId}] ${s.status}  ${s.updatedAt.slice(0, 10)}  ${goal}\n`);
  }
  return 0;
}
