/**
 * `continuum sessions` — recent-session listing, lifecycle (close/archive),
 * and safe cleanup of smoke/test noise.
 *
 *   sessions list   [--limit N] [--status active|archived|all]
 *   sessions close  <id>          mark completed (finished)
 *   sessions archive <id>          set aside (abandoned, kept on disk)
 *   sessions clean  [--dry-run]    delete only obvious smoke/test sessions
 *   sessions purge  [--older-than ISO]  delete finished sessions older than cutoff
 */

import { createPrompt, noopOutput } from "../../auth/prompt.js";
import {
  listSessions,
  archiveFinishedSessions,
  cleanupSmokeSessions,
  type SessionListFilter,
} from "../../launcher/session-list.js";
import { SessionNotFoundError } from "../../session/errors.js";
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

  switch (sub) {
    case "close":
    case "complete": {
      const id = rest.find((a) => !a.startsWith("-"));
      if (!id) {
        out("Usage: continuum sessions close <sessionId>\n");
        return 2;
      }
      try {
        await sessionManager.setStatus(id, "completed");
        out(`Closed session ${id} (marked completed).\n`);
        return 0;
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          out(`${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
    case "archive": {
      const id = rest.find((a) => !a.startsWith("-"));
      if (!id) {
        out("Usage: continuum sessions archive <sessionId>\n");
        return 2;
      }
      try {
        await sessionManager.setStatus(id, "abandoned");
        out(`Archived session ${id} (set aside; kept on disk).\n`);
        return 0;
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          out(`${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
    case "clean": {
      const dryRun = rest.includes("--dry-run");
      const removed = await cleanupSmokeSessions(sessionManager, dryRun);
      if (dryRun) {
        out(`${removed.length} smoke/test session${removed.length === 1 ? "" : "s"} would be removed (dry-run).\n`);
        for (const id of removed) out(`  ${id}\n`);
      } else {
        out(`Removed ${removed.length} smoke/test session${removed.length === 1 ? "" : "s"}.\n`);
      }
      return 0;
    }
    case "purge": {
      const olderThan = opt(rest, "--older-than") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const archived = await archiveFinishedSessions(sessionManager, olderThan);
      out(`Purged ${archived.length} finished session${archived.length === 1 ? "" : "s"}.\n`);
      return 0;
    }
  }

  // Default: list (active by default, newest-first). Flags may appear with or
  // without the `list` keyword (`sessions --status X` == `sessions list --status X`).
  const listArgs = sub === "list" ? rest : args;
  const statusArg = opt(listArgs, "--status");
  const filter: SessionListFilter = statusArg === "archived" || statusArg === "all" ? statusArg : "active";
  const limit = Number(opt(listArgs, "--limit") ?? "20");
  // The default view is genuinely in-flight sessions only; terminal
  // completed/abandoned smoke sessions belong under `--status archived`.
  const sessions = await listSessions(sessionManager, filter, Number.isFinite(limit) ? limit : 20);

  const label = filter === "archived" ? "archived" : filter === "all" ? "" : "active";
  out(label ? `${label} sessions:\n` : "sessions:\n");
  if (sessions.length === 0) {
    out("  (none)\n");
    return 0;
  }
  for (const s of sessions) {
    const goal = s.taskGoal.length > 60 ? `${s.taskGoal.slice(0, 57)}…` : s.taskGoal;
    out(`  - ${s.sessionId}  [${s.providerId}] ${s.status}  ${s.updatedAt.slice(0, 10)}  ${goal}\n`);
  }
  return 0;
}
