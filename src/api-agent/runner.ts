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
 *
 * This is the ONE HTTP client CONTINUUM's own process owns for provider
 * traffic (CLI-launched sessions spawn the provider's own binary instead —
 * see launcher.ts / health/launch-guard.ts for that path's local-dependency
 * check). Network failures are classified (DNS / connection-refused /
 * timeout / TLS / auth / rate-limit / server-error / other-http) and only
 * the genuinely transient kinds are retried, with bounded exponential
 * backoff + jitter, honoring a `Retry-After` header when the provider sends
 * one. Auth and other 4xx failures fail immediately — retrying a bad
 * credential or malformed request would only produce the identical error
 * `maxAttempts` times.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { ToolDefinition } from "../mcp/tools.js";
import { toAnthropicTools, toOpenAiTools } from "./format.js";
import { ApiAgentError, type AgentMessage, type AgentTurnResult, type NetworkFailureKind } from "./types.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; body: string; retryAfterMs?: number }>;

export interface ApiRunner {
  call(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): Promise<AgentTurnResult>;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly kind: NetworkFailureKind;
  readonly host: string;
}

export interface RunnerDeps {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Injectable sleep (tests); defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Bounded retry ceiling for transient failures. Default 4 (1 initial + 3 retries). */
  readonly maxAttempts?: number;
  /** Fired before each retry backoff — the single hook for stateful "retrying" UX. */
  readonly onRetry?: (info: RetryInfo) => void;
  /**
   * Secret-resolution source for auth headers (defaults to `process.env`).
   * The launcher passes the launch plan's resolved env so a credential from
   * the OS store reaches this in-process runner — without mutating
   * `process.env` globally.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

function defaultFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      return { ok: res.ok, status: res.status, body: await res.text(), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const whenMs = Date.parse(header);
  return Number.isFinite(whenMs) ? Math.max(0, whenMs - Date.now()) : undefined;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim().slice(0, 300);
}

interface Classified {
  readonly kind: NetworkFailureKind;
  readonly retryable: boolean;
  readonly message: string;
}

/** Classifies a thrown exception from `fetch()` itself (DNS/TCP/TLS/timeout — never reached HTTP). */
function classifyException(err: unknown, host: string): Classified {
  const name = err instanceof Error ? err.name : "";
  const cause = err instanceof Error ? (err as { cause?: { code?: string } }).cause : undefined;
  const code = cause?.code ?? (err as { code?: string } | undefined)?.code;

  if (name === "AbortError") {
    return { kind: "timeout", retryable: true, message: `${host} timed out` };
  }
  if (code === "ECONNREFUSED") {
    return { kind: "connection-refused", retryable: true, message: `${host} refused the connection (ECONNREFUSED)` };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { kind: "dns", retryable: true, message: `${host} could not be resolved (DNS lookup failed)` };
  }
  // Node/OpenSSL TLS error codes are an open-ended set (UNABLE_TO_VERIFY_LEAF_SIGNATURE,
  // DEPTH_ZERO_SELF_SIGNED_CERT, CERT_HAS_EXPIRED, ...) — most don't share a
  // common prefix, so match on the code OR the underlying message text.
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  if ((typeof code === "string" && (code.includes("CERT") || code.includes("TLS") || code.includes("SSL"))) || /certificate|tls|ssl/.test(msg)) {
    // TLS/certificate failures are a config/trust problem, not a transient
    // network blip — retrying would just repeat the same handshake failure.
    return { kind: "tls", retryable: false, message: `${host} TLS handshake failed (${code ?? "certificate error"})` };
  }
  return { kind: "connection-refused", retryable: true, message: `${host} unreachable (${code ?? name ?? "network error"})` };
}

/** Classifies an HTTP response CONTINUUM actually received (`res.ok === false`). */
function classifyStatus(status: number, host: string, bodyFirstLine: string): Classified {
  if (status === 401 || status === 403) {
    // Invalid/expired credentials are never retryable — see providers/errors.ts's
    // ProviderAuthError for the CLI-launch equivalent of this same classification.
    return { kind: "auth", retryable: false, message: `${host} rejected credentials (HTTP ${status}): ${bodyFirstLine}` };
  }
  if (status === 429) {
    return { kind: "rate-limit", retryable: true, message: `${host} rate-limited the request (HTTP 429): ${bodyFirstLine}` };
  }
  if (status >= 500) {
    return { kind: "server-error", retryable: true, message: `${host} returned a server error (HTTP ${status}): ${bodyFirstLine}` };
  }
  // Other 4xx (400 bad request, 404, 422, ...) is a config/payload problem —
  // retrying an identical malformed request only reproduces the same error.
  return { kind: "http-error", retryable: false, message: `${host} returned HTTP ${status}: ${bodyFirstLine}` };
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = Math.random() * exp * 0.25;
  return Math.round(exp + jitter);
}

/**
 * The ONE retry loop in CONTINUUM's own HTTP layer. Each attempt is a single
 * fetch; classification decides retry-or-throw; only one place ever calls
 * `sleep`, so nothing here can stack with an outer retry (there isn't one —
 * CLI-launched providers never go through this function at all).
 */
async function callWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  retry: { sleep: (ms: number) => Promise<void>; maxAttempts: number; onRetry?: (info: RetryInfo) => void },
): Promise<{ status: number; body: string }> {
  const host = hostOf(url);

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    let classified: Classified;
    let retryAfterMs: number | undefined;
    let ok: { status: number; body: string } | undefined;
    try {
      const res = await fetchImpl(url, init);
      if (res.ok) {
        ok = { status: res.status, body: res.body };
        classified = { kind: "http-error", retryable: false, message: "" }; // unused on success
      } else {
        classified = classifyStatus(res.status, host, firstLine(res.body));
        retryAfterMs = res.retryAfterMs;
      }
    } catch (err) {
      classified = classifyException(err, host);
    }

    if (ok) return ok;

    const isLastAttempt = attempt === retry.maxAttempts;
    if (!classified.retryable || isLastAttempt) {
      throw new ApiAgentError(classified.message, { kind: classified.kind, host, retryable: classified.retryable, attempts: attempt });
    }
    const delayMs = backoffMs(attempt, retryAfterMs);
    retry.onRetry?.({ attempt, maxAttempts: retry.maxAttempts, delayMs, kind: classified.kind, host });
    await retry.sleep(delayMs);
  }
  // Unreachable (the loop above always returns or throws); satisfies control-flow analysis.
  throw new ApiAgentError(`${host}: exhausted retries`, { host, retryable: false, attempts: retry.maxAttempts });
}

export function createApiRunner(adapter: ProviderAdapter, deps: RunnerDeps = {}): ApiRunner {
  const fetchImpl = deps.fetch ?? defaultFetch(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retry = { sleep, maxAttempts, onRetry: deps.onRetry };
  const env = deps.env ?? process.env;
  const protocol = adapter.getCapabilities().protocol;
  const baseUrl = adapter.profile.baseUrl.replace(/\/+$/, "");
  const model = adapter.resolveModel();

  async function call(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): Promise<AgentTurnResult> {
    if (protocol === "openai-compatible") return openAiCall(fetchImpl, retry, adapter, baseUrl, model, messages, tools, env);
    if (protocol === "anthropic-messages") return anthropicCall(fetchImpl, retry, adapter, baseUrl, model, messages, tools, env);
    throw new ApiAgentError(`unsupported protocol: ${protocol}`);
  }

  return { call };
}

type Retry = { sleep: (ms: number) => Promise<void>; maxAttempts: number; onRetry?: (info: RetryInfo) => void };

async function openAiCall(
  fetchImpl: FetchLike,
  retry: Retry,
  adapter: ProviderAdapter,
  baseUrl: string,
  model: string,
  messages: readonly AgentMessage[],
  tools: readonly ToolDefinition[],
  env: Readonly<Record<string, string | undefined>>,
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

  const headers = { "content-type": "application/json", ...adapter.buildAuthHeaders(env) };
  const res = await callWithRetry(fetchImpl, `${baseUrl}/chat/completions`, { method: "POST", headers, body }, retry);

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
  retry: Retry,
  adapter: ProviderAdapter,
  baseUrl: string,
  model: string,
  messages: readonly AgentMessage[],
  tools: readonly ToolDefinition[],
  env: Readonly<Record<string, string | undefined>>,
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

  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...adapter.buildAuthHeaders(env) };
  const res = await callWithRetry(fetchImpl, `${baseUrl}/v1/messages`, { method: "POST", headers, body }, retry);

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
