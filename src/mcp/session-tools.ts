/**
 * Session/project context tools — read-only surface over CONTINUUM's local
 * state (SessionManager, ProjectRegistry, recent-session list). No MemoryCore
 * here; this is the "what is the current task/session/project" half.
 *
 * Isolation: every tool that returns a specific session/project resolves it by
 * an explicit id and returns only that scope's summary. The recent-session
 * listing returns bounded summaries (id, project, provider, status, goal
 * prefix) — never the full session body, never cross-project memory. There is
 * no tool that enumerates every session's contents.
 */

import type { SessionManager } from "../session/manager.js";
import type { ProjectRegistry } from "../registry/registry.js";
import { listRecentSessions } from "../launcher/session-list.js";
import { jsonResult, textResult, type RegisteredTool } from "./tools.js";

export interface SessionToolDeps {
  readonly sessionManager: SessionManager;
  readonly projects: ProjectRegistry;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

export function buildSessionTools(deps: SessionToolDeps): RegisteredTool[] {
  const { sessionManager, projects } = deps;
  return [
    {
      definition: {
        name: "session_state",
        description: "Get the current state of a CONTINUUM task session by id: goal, status, active provider, completed/remaining work, decisions, relevant files, and stale-worktree info. Read-only.",
        cacheScope: "session" as const,
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string", description: "The task session id." } },
          required: ["sessionId"],
          additionalProperties: false,
        },
        access: "read",
      },
      handler: async (args) => {
        const sessionId = stringArg(args, "sessionId");
        if (!sessionId) return textResult("session_state requires \"sessionId\".", true);
        try {
          const s = await sessionManager.loadSession(sessionId);
          return jsonResult({
            sessionId: s.sessionId,
            projectId: s.projectId,
            status: s.status,
            provider: s.activeProvider.providerId,
            model: s.activeProvider.model,
            taskGoal: s.taskGoal,
            completedWork: s.completedWork.map((w) => w.description),
            remainingWork: s.remainingWork.map((w) => w.description),
            decisions: s.importantDecisions.map((d) => d.decision),
            relevantFiles: s.relevantFiles.map((f) => f.path),
            lastHandoff: s.lastHandoff ? { from: s.lastHandoff.fromProvider.providerId, to: s.lastHandoff.toProvider.providerId } : null,
          });
        } catch (err) {
          return textResult(`session_state failed: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    },
    {
      definition: {
        name: "session_recent",
        description: "List recent CONTINUUM task sessions (newest first, bounded). Read-only.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "Max entries (default 20)." } },
          additionalProperties: false,
        },
        access: "read",
      },
      handler: async (args) => {
        const limit = typeof args.limit === "number" ? args.limit : 20;
        const sessions = await listRecentSessions(sessionManager, limit);
        return jsonResult(sessions.map((s) => ({ sessionId: s.sessionId, projectId: s.projectId, provider: s.providerId, status: s.status, goal: s.taskGoal.slice(0, 80) })));
      },
    },
    {
      definition: {
        name: "project_state",
        description: "Get a registered project's metadata: name, path, aliases, default provider/model. Read-only.",
        cacheScope: "project" as const,
        inputSchema: {
          type: "object",
          properties: { project: { type: "string", description: "Project name, alias, or id." } },
          required: ["project"],
          additionalProperties: false,
        },
        access: "read",
      },
      handler: async (args) => {
        const key = stringArg(args, "project");
        if (!key) return textResult("project_state requires \"project\".", true);
        try {
          const p = await projects.resolve(key);
          return jsonResult({ id: p.id, name: p.name, path: p.path, aliases: p.aliases, defaultProvider: p.defaultProvider ?? null, defaultModel: p.defaultModel ?? null });
        } catch (err) {
          return textResult(`project_state failed: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    },
    {
      definition: {
        name: "project_list",
        description: "List all registered projects (name, path, default provider). Read-only.",
        cacheScope: "project" as const,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        access: "read",
      },
      handler: async () => {
        const list = await projects.list();
        return jsonResult(list.map((p) => ({ name: p.name, path: p.path, aliases: p.aliases, defaultProvider: p.defaultProvider ?? null })));
      },
    },
  ];
}
