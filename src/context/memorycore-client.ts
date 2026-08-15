/**
 * MemoryCore Gateway client — the integration boundary for Tencent Memory
 * (Phase 4 requirement #3: "Use MemoryCore's Gateway/API as the boundary
 * where practical... Do not fork/rewrite the L0→L3 engine").
 *
 * Deliberately calls the exact same `/v3/*` "strong isolation" endpoints
 * `MemoryProxy/src/tdai/client.ts` already uses in production
 * (`readL3ForCtx` → `/v3/core/read`, `listL2ForCtx` → `/v3/scenario/ls`,
 * `searchL1ForCtx` → `/v3/atomic/search`) — verified by reading that file,
 * not guessed — so this is the same proven wire contract, not a new one.
 *
 * `/recall` (the v1 endpoint `auto-recall.ts` backs) was considered and
 * rejected as the primary source: its `RecallResponse` only returns
 * `context` (`appendSystemContext`), silently dropping `prependContext`
 * (the dynamic L1 half) entirely — verified by reading
 * `MemoryCore/src/gateway/server.ts`'s `handleRecall`. The `/v3/*` routes
 * return structured, individually-provenanced items instead of a
 * pre-rendered blob, which is what a Context Manager needs anyway. See
 * PHASE_4_CONTEXT_ARCHITECTURE.md §2 for the full comparison.
 */

import { resolveSecret, type SecretRef } from "../providers/secrets.js";

export interface MemoryCoreGatewayConfig {
  readonly baseUrl: string;
  readonly serviceToken: SecretRef;
  readonly serviceId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly timeoutMs?: number;
}

export interface FetchedPersona {
  readonly content: string;
  readonly updatedAt?: string;
}

export interface FetchedSceneEntry {
  readonly path: string;
  readonly summary?: string;
  readonly updatedAt?: string;
}

export interface FetchedStableContent {
  readonly persona: FetchedPersona | null;
  readonly sceneIndex: readonly FetchedSceneEntry[];
}

export interface FetchedRecallItem {
  readonly id: string;
  readonly type?: string;
  readonly content: string;
  readonly score?: number;
  readonly updatedAt?: string;
}

export interface FetchedDynamicRecall {
  readonly items: readonly FetchedRecallItem[];
}

const DEFAULT_TIMEOUT_MS = 5000;

function buildHeaders(cfg: MemoryCoreGatewayConfig, includeSession: boolean, includeTask: boolean): Record<string, string> {
  const token = resolveSecret("memorycore-gateway", cfg.serviceToken);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-tdai-service-id": cfg.serviceId,
    "x-tdai-team-id": cfg.teamId,
    "x-tdai-user-id": cfg.userId,
    "x-tdai-agent-id": cfg.agentId,
  };
  if (includeSession && cfg.sessionId) headers["x-tdai-session-id"] = cfg.sessionId;
  if (includeTask && cfg.taskId) headers["x-tdai-task-id"] = cfg.taskId;
  return headers;
}

async function postV3<T>(
  cfg: MemoryCoreGatewayConfig,
  path: string,
  body: Record<string, unknown>,
  opts: { includeSession: boolean; includeTask: boolean },
): Promise<T> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: buildHeaders(cfg, opts.includeSession, opts.includeTask),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`MemoryCore Gateway ${path} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** L3 persona + L2 scene index — the stable half. Read-only, never mutates. */
export async function fetchStableFromMemoryCore(cfg: MemoryCoreGatewayConfig): Promise<FetchedStableContent> {
  const [core, scenario] = await Promise.all([
    postV3<Record<string, unknown> | null>(
      cfg,
      "/v3/core/read",
      { team_id: cfg.teamId, agent_id: cfg.agentId },
      { includeSession: false, includeTask: false },
    ),
    postV3<{ entries?: Array<Record<string, unknown>> }>(
      cfg,
      "/v3/scenario/ls",
      { team_id: cfg.teamId, agent_id: cfg.agentId, path_prefix: "" },
      { includeSession: false, includeTask: true },
    ),
  ]);

  const personaContent = typeof core?.content === "string" ? core.content : "";
  const persona: FetchedPersona | null = personaContent
    ? { content: personaContent, updatedAt: typeof core?.updated_at === "string" ? core.updated_at : undefined }
    : null;

  const sceneIndex = (scenario.entries ?? [])
    .map((e): FetchedSceneEntry => ({
      path: String(e.path ?? ""),
      summary: typeof e.summary === "string" ? e.summary : undefined,
      updatedAt: typeof e.updated_at === "string" ? e.updated_at : undefined,
    }))
    .filter((e) => e.path && !e.path.endsWith("/"));

  return { persona, sceneIndex };
}

/** L1 relevant-memory search — the dynamic half. Read-only, never mutates. */
export async function fetchDynamicRecallFromMemoryCore(
  cfg: MemoryCoreGatewayConfig,
  query: string,
  limit = 5,
): Promise<FetchedDynamicRecall> {
  if (!query.trim()) return { items: [] };

  const data = await postV3<{ items?: Array<Record<string, unknown>> }>(
    cfg,
    "/v3/atomic/search",
    {
      team_id: cfg.teamId,
      user_id: cfg.userId,
      agent_id: cfg.agentId,
      session_id: cfg.sessionId,
      task_id: cfg.taskId,
      query: query.slice(0, 2048),
      limit,
    },
    { includeSession: true, includeTask: true },
  );

  const items = (data.items ?? [])
    .map((item): FetchedRecallItem => ({
      id: String(item.id ?? ""),
      type: typeof item.type === "string" ? item.type : undefined,
      content: typeof item.content === "string" ? item.content : "",
      score: typeof item.score === "number" ? item.score : undefined,
      updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
    }))
    .filter((m) => m.id && m.content);

  return { items };
}
