/**
 * MemoryCore Gateway *write* client — the counterpart to
 * `memorycore-client.ts`'s read-only fetch functions. Uses the exact same
 * `/v3/*` "strong isolation" wire contract and header set, so the write path
 * is the same boundary, just the mutating verbs. Deliberately narrow: only the
 * capture/store primitives a minimal MCP layer needs. No new protocol.
 *
 * Endpoints (verified against MemoryCore/src/gateway/v2-router.ts's route map):
 *   - `/v3/conversation/add`  → L0 capture (triggers L1 extraction)
 *   - `/v3/atomic/update`     → L1 atomic upsert-by-id
 *   - `/v3/core/write`        → L3 core/persona write
 *
 * Every write reuses `resolveSecret` for the service token (injected at the
 * boundary, never exposed), exactly like the read client.
 */

import { resolveSecret, type SecretRef } from "../providers/secrets.js";
import type { MemoryCoreGatewayConfig } from "./memorycore-client.js";

type HttpMethod = "POST";

interface WriteResult {
  readonly code: number;
  readonly data?: unknown;
}

function buildHeaders(cfg: MemoryCoreGatewayConfig): Record<string, string> {
  const token = resolveSecret("memorycore-gateway", cfg.serviceToken);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-tdai-service-id": cfg.serviceId,
    "x-tdai-team-id": cfg.teamId,
    "x-tdai-user-id": cfg.userId,
    "x-tdai-agent-id": cfg.agentId,
    ...(cfg.sessionId ? { "x-tdai-session-id": cfg.sessionId } : {}),
    ...(cfg.taskId ? { "x-tdai-task-id": cfg.taskId } : {}),
  };
}

async function postV3(
  cfg: MemoryCoreGatewayConfig,
  path: string,
  body: Record<string, unknown>,
  method: HttpMethod = "POST",
): Promise<WriteResult> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 5000);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: buildHeaders(cfg),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`MemoryCore Gateway ${path} returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { code?: number; data?: unknown };
    return { code: typeof json.code === "number" ? json.code : 0, data: json.data };
  } finally {
    clearTimeout(timer);
  }
}

/** L0 capture — store conversation turns; triggers async L1 extraction. */
export async function captureConversation(
  cfg: MemoryCoreGatewayConfig,
  args: { messages: readonly unknown[]; sessionId?: string },
): Promise<WriteResult> {
  return postV3(cfg, "/v3/conversation/add", {
    team_id: cfg.teamId,
    user_id: cfg.userId,
    agent_id: cfg.agentId,
    session_id: args.sessionId ?? cfg.sessionId ?? "",
    messages: args.messages,
  });
}

/** L1 atomic upsert — store/update a single memory atom by id. */
export async function updateAtomicMemory(
  cfg: MemoryCoreGatewayConfig,
  args: { id: string; content: string; background?: string },
): Promise<WriteResult> {
  return postV3(cfg, "/v3/atomic/update", {
    team_id: cfg.teamId,
    user_id: cfg.userId,
    agent_id: cfg.agentId,
    id: args.id,
    content: args.content,
    ...(args.background ? { background: args.background } : {}),
  });
}

/** L3 core write — persist/refresh the persona-level core memory file. */
export async function writeCoreMemory(
  cfg: MemoryCoreGatewayConfig,
  args: { content: string },
): Promise<WriteResult> {
  return postV3(cfg, "/v3/core/write", {
    team_id: cfg.teamId,
    agent_id: cfg.agentId,
    content: args.content,
  });
}
