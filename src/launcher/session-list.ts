/**
 * Recent-session listing/cleanup helpers — surface sessions by recency so a
 * user never has to recall a session id, and archive/retire old or finished
 * sessions so the list stays usable. Read-only listing + a bounded archive
 * operation; no session-state logic lives here (that's `SessionManager`).
 */

import type { SessionManager } from "../session/manager.js";
import type { SessionMode, TaskSession } from "../session/types.js";

export interface RecentSessionSummary {
  readonly sessionId: string;
  /** Set only for `mode === "project"`. */
  readonly projectId?: string;
  readonly mode: SessionMode;
  readonly workingDirectory: string;
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
  const ids = await sessionManager.listSessionIds();
  const loaded: RecentSessionSummary[] = [];
  for (const id of ids) {
    try {
      const s = await sessionManager.loadSession(id);
      const updatedAt = await effectiveUpdatedAt(sessionManager, id, s);
      loaded.push(summarize(s, updatedAt));
    } catch {
      // skip unreadable sessions
    }
  }
  loaded.sort((a, b) => compareTimestampsDesc(a.updatedAt, b.updatedAt));
  return loaded.slice(0, limit);
}

/**
 * Resolves the ordering/timestamp key for a loaded session. Prefers
 * `updatedAt` (last active), then `createdAt`, then the session file's mtime,
 * then epoch — so legacy sessions that predate the `updatedAt` field still get
 * a deterministic, non-crashing place in the list.
 */
async function effectiveUpdatedAt(sessionManager: SessionManager, sessionId: string, s: TaskSession): Promise<string> {
  if (s.updatedAt) return s.updatedAt;
  if (s.createdAt) return s.createdAt;
  return (await sessionManager.sessionFileMtimeIso(sessionId)) ?? new Date(0).toISOString();
}

/** Descending timestamp comparison (newest first), stable for equal timestamps. */
export function compareTimestampsDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function summarize(s: TaskSession, updatedAt: string): RecentSessionSummary {
  return {
    sessionId: s.sessionId,
    ...(s.projectId ? { projectId: s.projectId } : {}),
    mode: s.mode,
    workingDirectory: s.workingDirectory,
    providerId: s.activeProvider.providerId,
    taskGoal: s.taskGoal,
    status: s.status,
    updatedAt,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function clock(d: Date): string {
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12; // 0 → 12, 13 → 1
  return `${hours}:${minutes} ${ampm}`;
}

/**
 * Local-time display for a session timestamp (ISO 8601):
 *   - today → `8:21 PM`
 *   - older → `Aug 15, 6:13 PM`
 * Falls back to the raw value for an unparseable timestamp rather than throwing.
 */
export function formatSessionTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = clock(d);
  return sameDay ? time : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}

/**
 * One entry in the interactive "Choose session:" picker. The first line is the
 * provider + goal (with a `★ ` marker when this is the most recently active
 * session); the second line is `Last active: <local time>`. The goal is
 * truncated to fit `width` (terminal columns) so long goals never wrap into an
 * unreadable menu.
 */
export function formatSessionPickerLine(
  s: RecentSessionSummary,
  opts: { readonly isNewest: boolean; readonly now?: Date; readonly width?: number },
): string {
  const now = opts.now ?? new Date();
  const width = typeof opts.width === "number" && opts.width > 0 ? opts.width : 80;
  const marker = opts.isNewest ? "★ " : "  ";
  const provider = `[${s.providerId}]`;
  // Reserve "  N. " (number prefix) + marker + provider + the space before the goal.
  const reserved = 5 + marker.length + provider.length + 1;
  const goalMax = Math.max(16, width - reserved);
  const goal = s.taskGoal.length > goalMax ? `${s.taskGoal.slice(0, goalMax - 1)}…` : s.taskGoal;
  const time = formatSessionTime(s.updatedAt, now);
  return `${marker}${provider} ${goal}\nLast active: ${time}${workspaceSuffix(s)}`;
}

/**
 * Extra workspace context appended to the picker's second line so a
 * general/current-directory session never reads as an unlabeled
 * `(untitled)` entry. Project-mode sessions are unchanged (empty suffix) —
 * their picker line stays exactly as before this field existed.
 */
function workspaceSuffix(s: RecentSessionSummary): string {
  if (s.mode === "general") return " · general session (no project)";
  if (s.mode === "current-directory") return ` · ${s.workingDirectory}`;
  return "";
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
