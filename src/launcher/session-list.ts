/**
 * Recent-session listing/cleanup helpers — surface sessions by recency so a
 * user never has to recall a session id, and archive/retire old or finished
 * sessions so the list stays usable. Read-only listing + a bounded archive
 * operation; no session-state logic lives here (that's `SessionManager`).
 */

import type { SessionManager } from "../session/manager.js";
import type { TaskSession } from "../session/types.js";

export interface RecentSessionSummary {
  readonly sessionId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly taskGoal: string;
  readonly status: string;
  readonly updatedAt: string;
}

/** The lifecycle grouping used by the session list: active (in-flight) vs archived (finished). */
export type SessionListFilter = "active" | "archived" | "all";

/** A session is "active" (in-flight) unless it has a terminal status. */
export function isActiveStatus(status: string): boolean {
  return status === "active" || status === "paused" || status === "handoff-pending";
}

/**
 * Lists sessions newest-first (by `updatedAt`), bound to `limit`. Skips
 * sessions that fail to load (e.g. corrupted) rather than failing the whole
 * listing — a degraded session shouldn't hide the rest.
 */
export async function listRecentSessions(sessionManager: SessionManager, limit = 20): Promise<RecentSessionSummary[]> {
  const ids = await sessionManager.listSessionIds(); // sessionManager delegates? see note
  const loaded: RecentSessionSummary[] = [];
  for (const id of ids) {
    try {
      const s = await sessionManager.loadSession(id);
      loaded.push(summarize(s));
    } catch {
      // skip unreadable sessions
    }
  }
  loaded.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return loaded.slice(0, limit);
}

function summarize(s: TaskSession): RecentSessionSummary {
  return {
    sessionId: s.sessionId,
    projectId: s.projectId,
    providerId: s.activeProvider.providerId,
    taskGoal: s.taskGoal,
    status: s.status,
    updatedAt: s.updatedAt,
  };
}

/**
 * Archives (deletes) sessions whose `status` is terminal (`completed` or
 * `abandoned`) and whose `updatedAt` is older than `olderThanIso`. Returns
 * the ids archived. This is the "keep the list usable" cleanup — bounded and
 * explicit, never touching active/paused/handoff-pending sessions.
 */
/**
 * Lists sessions by lifecycle group (newest-first within each group), bound to
 * `limit`. `active` = in-flight; `archived` = finished (completed/abandoned);
 * `all` = no filtering.
 */
export async function listSessions(
  sessionManager: SessionManager,
  filter: SessionListFilter,
  limit = 20,
): Promise<RecentSessionSummary[]> {
  const all = await listRecentSessions(sessionManager, Number.MAX_SAFE_INTEGER);
  const filtered = filter === "all" ? all : all.filter((s) => (filter === "active" ? isActiveStatus(s.status) : !isActiveStatus(s.status)));
  return filtered.slice(0, limit);
}

/**
 * True when a session is an obvious smoke/test artifact — a trivial/empty or
 * explicitly test-shaped goal AND no recorded work of any kind. Real work is
 * never matched, so cleanup can only ever remove noise.
 */
export function isSmokeSession(s: TaskSession): boolean {
  const goal = s.taskGoal.trim().toLowerCase();
  const trivialGoal =
    goal === "" ||
    goal === "(untitled)" ||
    goal === "(no explicit goal supplied)";
  // Only match explicit smoke markers — the bare word "test" is too broad (a
  // real task can be "write tests"). Safety over reach: never delete real work.
  const smokeShaped = /\bsmoke\b/.test(goal) || goal.includes("daily workflow");
  const noWork =
    s.completedWork.length === 0 &&
    s.remainingWork.length === 0 &&
    s.importantDecisions.length === 0 &&
    s.relevantFiles.length === 0 &&
    s.recentToolActivity.length === 0;
  return noWork && (trivialGoal || smokeShaped);
}

/**
 * Deletes only obvious smoke/test sessions (per `isSmokeSession`). Returns the
 * ids deleted. `dryRun` reports without deleting. Never touches a session with
 * recorded work.
 */
export async function cleanupSmokeSessions(
  sessionManager: SessionManager,
  dryRun = false,
): Promise<string[]> {
  const ids = await sessionManager.listSessionIds();
  const removed: string[] = [];
  for (const id of ids) {
    try {
      const s = await sessionManager.loadSession(id);
      if (!isSmokeSession(s)) continue;
      if (!dryRun) await sessionManager.deleteSession(id);
      removed.push(id);
    } catch {
      // skip unreadable sessions
    }
  }
  return removed;
}

export async function archiveFinishedSessions(
  sessionManager: SessionManager,
  olderThanIso: string,
): Promise<string[]> {
  const ids = await sessionManager.listSessionIds();
  const archived: string[] = [];
  for (const id of ids) {
    try {
      const s = await sessionManager.loadSession(id);
      if ((s.status === "completed" || s.status === "abandoned") && s.updatedAt < olderThanIso) {
        await sessionManager.deleteSession(id);
        archived.push(id);
      }
    } catch {
      // skip unreadable sessions
    }
  }
  return archived;
}
