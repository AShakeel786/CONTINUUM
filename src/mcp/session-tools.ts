/**
 * Session/project tools over CONTINUUM's local state (SessionManager,
 * ProjectRegistry, recent-session list). No MemoryCore here; this is the
 * "what is the current task/session/project" half plus the one compact write
 * surface (`session_update`) that keeps task continuity populated during work.
 *
 * Isolation: read tools resolve a specific session/project by an explicit id
 * and return only that scope's summary (never the full body, never cross-
 * project memory). The single write tool requires an explicit `sessionId` and
 * only ever appends to that one session's bounded lists.
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

const MAX_TEXT_LEN = 4000;

/** A required, non-empty, bounded string field — returns undefined (invalid) otherwise. */
function requiredText(args: Record<string, unknown>, key: string): string | undefined {
  const v = stringArg(args, key);
  if (!v || !v.trim()) return undefined;
  const t = v.trim();
  return t.length <= MAX_TEXT_LEN ? t : undefined;
}

/** An optional bounded string field (absent/empty → undefined). */
function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const v = stringArg(args, key);
  if (!v || !v.trim()) return undefined;
  const t = v.trim();
  return t.length <= MAX_TEXT_LEN ? t : undefined;
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
    {
      definition: {
        name: "session_update",
        description:
          "Record progress on an existing CONTINUUM task session so the next agent can continue without re-auditing. One op per call: complete_work | add_remaining_work | record_decision | record_relevant_file | record_tool_activity. Requires the sessionId from your injected session context. Write-only.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "The task session id (from your session context)." },
            op: {
              type: "string",
              enum: ["complete_work", "add_remaining_work", "record_decision", "record_relevant_file", "record_tool_activity"],
            },
            description: { type: "string", description: "complete_work / add_remaining_work: one line of what was done / what remains." },
            decision: { type: "string", description: "record_decision: the decision made." },
            rationale: { type: "string", description: "record_decision (optional): why." },
            path: { type: "string", description: "record_relevant_file: the file path." },
            note: { type: "string", description: "record_relevant_file (optional): why it matters." },
            tool: { type: "string", description: "record_tool_activity: the tool name." },
            summary: { type: "string", description: "record_tool_activity: one line of what it did." },
          },
          required: ["sessionId", "op"],
          additionalProperties: false,
        },
        access: "write",
      },
      handler: async (args) => {
        const sessionId = stringArg(args, "sessionId");
        const op = stringArg(args, "op");
        if (!sessionId || !op) return textResult('session_update requires "sessionId" and "op".', true);
        try {
          await sessionManager.loadSession(sessionId); // 404 → error, no write
        } catch (err) {
          return textResult(`session_update: unknown session (${err instanceof Error ? err.message : String(err)}).`, true);
        }

        switch (op) {
          case "complete_work": {
            const description = requiredText(args, "description");
            if (!description) return textResult('session_update complete_work requires a non-empty "description".', true);
            const s = await sessionManager.addCompletedWork(sessionId, description);
            return jsonResult({ ok: true, completedWork: s.completedWork.length });
          }
          case "add_remaining_work": {
            const description = requiredText(args, "description");
            if (!description) return textResult('session_update add_remaining_work requires a non-empty "description".', true);
            const s = await sessionManager.addRemainingWork(sessionId, description);
            return jsonResult({ ok: true, remainingWork: s.remainingWork.length });
          }
          case "record_decision": {
            const decision = requiredText(args, "decision");
            if (!decision) return textResult('session_update record_decision requires a non-empty "decision".', true);
            const rationale = optionalText(args, "rationale");
            const s = await sessionManager.recordDecision(sessionId, decision, rationale);
            return jsonResult({ ok: true, decisions: s.importantDecisions.length });
          }
          case "record_relevant_file": {
            const path = requiredText(args, "path");
            if (!path) return textResult('session_update record_relevant_file requires a non-empty "path".', true);
            const note = optionalText(args, "note");
            const s = await sessionManager.recordRelevantFile(sessionId, path, note);
            return jsonResult({ ok: true, relevantFiles: s.relevantFiles.length });
          }
          case "record_tool_activity": {
            const tool = requiredText(args, "tool");
            const summary = requiredText(args, "summary");
            if (!tool || !summary) return textResult('session_update record_tool_activity requires "tool" and "summary".', true);
            const s = await sessionManager.recordToolActivity(sessionId, tool, summary);
            return jsonResult({ ok: true, recentToolActivity: s.recentToolActivity.length });
          }
          default:
            return textResult(`session_update: unknown op "${op}".`, true);
        }
      },
    },
  ];
}
