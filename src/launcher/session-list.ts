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
