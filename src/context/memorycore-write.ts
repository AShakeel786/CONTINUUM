/**
 * MemoryCore Gateway *write* client — the counterpart to
 * `memorycore-client.ts`'s read-only fetch functions. Uses the exact same
 * `/v3/*` "strong isolation" wire contract and header set, so the write path
 * is the same boundary, just the mutating verbs. Deliberately narrow: only the
 * capture/store primitives a minimal MCP layer needs. No new protocol.
 *
 * Endpoints (verified against MemoryCore/src/gateway/v2-router.ts's route map):
 *   - `POST /capture` (v1)      → turn capture that triggers L0→L1→L2→L3
 *   - `/v3/conversation/add`    → low-level L0 write (no extraction trigger)
 *   - `/v3/atomic/update`       → L1 atomic upsert-by-id
 *   - `/v3/core/write`          → L3 core/persona write
 *
 * The two capture paths are deliberately distinct (see PHASE_11 semantics):
 *   - `captureTurn`  → `/capture`: the high-level "commit a completed turn"
 *     primitive. In standalone mode this is the ONLY path that triggers the
 *     async extraction pipeline (L0 record → L1 atoms → L2 scenes → L3 persona).
 *     It is scoped by `session_key` only — team/user/agent fall back to the
 *     gateway's default bucket (a MemoryCore v1 limitation, not ours).
 *   - `captureConversation` → `/v3/conversation/add`: the low-level "append
 *     isolated L0 messages" primitive. Honors team/user/agent isolation but
 *     does NOT trigger extraction in standalone (the pipeline-notify hook is
 *     service-mode only). Use it only where explicit multi-dim isolation or
 *     raw message control is the actual requirement.
 *
 * Every write reuses `resolveSecret` for the service token (injected at the
 * boundary, never exposed), exactly like the read client.
 */

import { resolveSecret, type SecretRef } from "../providers/secrets.js";
import type { MemoryCoreGatewayConfig } from "./memorycore-client.js";

/**
 * MemoryCore's own `/v3` isolation default (`DEFAULT_ISOLATION_ID`). The
 * gateway rejects an empty-string `session_id` (`session_id: Too small —
 * expected >=1 chars`), so a capture with no explicit session falls back to
 * the gateway's built-in bucket rather than sending "".
 */
const DEFAULT_SESSION_ID = "default";

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

/** Low-level L0 write — append isolated conversation messages. Does NOT trigger
 * the extraction pipeline in standalone (that is `captureTurn`'s job). */
export async function captureConversation(
  cfg: MemoryCoreGatewayConfig,
  args: { messages: readonly unknown[]; sessionId?: string },
): Promise<WriteResult> {
  return postV3(cfg, "/v3/conversation/add", {
    team_id: cfg.teamId,
    user_id: cfg.userId,
    agent_id: cfg.agentId,
    session_id: args.sessionId ?? cfg.sessionId ?? DEFAULT_SESSION_ID,
    messages: args.messages,
  });
}

/** Result of a v1 `/capture` turn commit. */
export interface CaptureTurnResult {
  readonly l0Recorded: number;
  readonly schedulerNotified: boolean;
}

/**
 * High-level turn capture — commit a completed user/assistant turn and trigger
 * the async L0→L1→L2→L3 extraction pipeline. In standalone mode this is the
 * only path that populates L1 atoms (CONTINUUM's normal "capture new memory"
 * semantics); `/v3/conversation/add` writes L0 in isolation but does not fire
 * the pipeline there.
 *
 * Hits the v1 `POST /capture` endpoint (raw 200 body, NOT the `/v3` `{code,data}`
 * envelope), so the response is unwrapped directly rather than via `postV3`.
 */
export async function captureTurn(
  cfg: MemoryCoreGatewayConfig,
  args: { userContent: string; assistantContent: string; sessionKey?: string; messages?: readonly unknown[] },
): Promise<CaptureTurnResult> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 5000);
  try {
    const res = await fetch(`${base}/capture`, {
      method: "POST",
      signal: controller.signal,
      headers: buildHeaders(cfg),
      body: JSON.stringify({
        user_content: args.userContent,
        assistant_content: args.assistantContent,
        session_key: args.sessionKey ?? cfg.sessionId ?? DEFAULT_SESSION_ID,
        ...(args.messages ? { messages: args.messages } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`MemoryCore Gateway /capture returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { l0_recorded?: number; scheduler_notified?: boolean };
    return {
      l0Recorded: typeof json.l0_recorded === "number" ? json.l0_recorded : 0,
      schedulerNotified: json.scheduler_notified === true,
    };
  } finally {
    clearTimeout(timer);
  }
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
