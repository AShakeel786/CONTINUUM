/**
 * Generic API runner — the one place CONTINUUM makes a direct provider API call
 * for the agent loop. Selected entirely from `capabilities.protocol` (never a
 * provider id): OpenAI-compatible → `/chat/completions`, Anthropic-compatible →
 * `/v1/messages`. Reuses `ProviderAdapter.buildAuthHeaders()` (so credentials
 * resolve through CredentialManager/SecretRef) and `resolveModel()`.
 *
 * Non-streaming first-class; streaming is a future optimization. A call
 * returns a unified `AgentTurnResult` (content + tool calls) regardless of
 * protocol. All errors become typed `ApiAgentError`s — never a raw stack.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { ToolDefinition } from "../mcp/tools.js";
import { toAnthropicTools, toOpenAiTools } from "./format.js";
import { ApiAgentError, type AgentMessage, type AgentTurnResult } from "./types.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: string }>;

export interface ApiRunner {
  call(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): Promise<AgentTurnResult>;
}

export interface RunnerDeps {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function defaultFetch(): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createApiRunner(adapter: ProviderAdapter, deps: RunnerDeps = {}): ApiRunner {
  const fetchImpl = deps.fetch ?? defaultFetch();
  const protocol = adapter.getCapabilities().protocol;
  const baseUrl = adapter.profile.baseUrl.replace(/\/+$/, "");
  const model = adapter.resolveModel();

  async function call(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): Promise<AgentTurnResult> {
    if (protocol === "openai-compatible") return openAiCall(fetchImpl, adapter, baseUrl, model, messages, tools);
    if (protocol === "anthropic-messages") return anthropicCall(fetchImpl, adapter, baseUrl, model, messages, tools);
    throw new ApiAgentError(`unsupported protocol: ${protocol}`);
  }

  return { call };
}

async function openAiCall(
  fetchImpl: FetchLike,
  adapter: ProviderAdapter,
  baseUrl: string,
  model: string,
  messages: readonly AgentMessage[],
  tools: readonly ToolDefinition[],
): Promise<AgentTurnResult> {
  const wire = messages.map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          ...(m.content !== null ? { content: m.content } : {}),
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) } : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });

  const body = JSON.stringify({
    model,
    messages: wire,
    ...(tools.length ? { tools: toOpenAiTools(tools), tool_choice: "auto" } : {}),
  });

  const headers = { "content-type": "application/json", ...adapter.buildAuthHeaders() };
  const res = await fetchImpl(`${baseUrl}/chat/completions`, { method: "POST", headers, body });
  if (!res.ok) {
    throw new ApiAgentError(`OpenAI-compatible API returned HTTP ${res.status}: ${firstLine(res.body)}`);
  }

  const parsed = JSON.parse(res.body) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
  };
  const choice = parsed.choices?.[0];
  const message = choice?.message;
  const toolCalls = (message?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
  return { content: message?.content ?? null, toolCalls, finishReason: choice?.finish_reason ?? "stop" };
}

async function anthropicCall(
  fetchImpl: FetchLike,
  adapter: ProviderAdapter,
  baseUrl: string,
  model: string,
  messages: readonly AgentMessage[],
  tools: readonly ToolDefinition[],
): Promise<AgentTurnResult> {
  // Anthropic has no system role in `messages`; system is a separate field.
  const systemParts = messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content);
  const system = systemParts.length ? systemParts.join("\n\n") : undefined;
  const wire = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      switch (m.role) {
        case "user":
          return { role: "user", content: m.content };
        case "assistant": {
          const content: Record<string, unknown>[] = [];
          if (m.content) content.push({ type: "text", text: m.content });
          for (const tc of m.toolCalls ?? []) {
            content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeJsonParse(tc.arguments) });
          }
          return { role: "assistant", content };
        }
        case "tool":
          return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
      }
    });

  const body = JSON.stringify({
    model,
    max_tokens: 8192,
    ...(system ? { system } : {}),
    messages: wire,
    ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
  });

  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...adapter.buildAuthHeaders() };
  const res = await fetchImpl(`${baseUrl}/v1/messages`, { method: "POST", headers, body });
  if (!res.ok) {
    throw new ApiAgentError(`Anthropic-compatible API returned HTTP ${res.status}: ${firstLine(res.body)}`);
  }

  const parsed = JSON.parse(res.body) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
  };
  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  for (const block of parsed.content ?? []) {
    if (block.type === "text" && block.text) textParts.push(block.text);
    else if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return { content: textParts.length ? textParts.join("\n") : null, toolCalls, finishReason: parsed.stop_reason ?? "end_turn" };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim().slice(0, 300);
}
