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
import { EndpointParamError, resolveEndpointUrl } from "../providers/endpoint.js";
import type { ToolDefinition } from "../mcp/tools.js";
import { toAnthropicTools, toOpenAiTools } from "./format.js";
import { ApiAgentError, type AgentMessage, type AgentTurnResult, type NetworkFailureKind, type RunnerCallOptions } from "./types.js";
import { consumeOpenAiStream, defaultStreamFetch, type StreamFetchLike } from "./stream.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; body: string; retryAfterMs?: number; resetAtMs?: number }>;

export interface ApiRunner {
  call(messages: readonly AgentMessage[], tools: readonly ToolDefinition[], opts?: RunnerCallOptions): Promise<AgentTurnResult>;
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
  /** Streaming fetch seam (tests); defaults to a real `fetch` body reader. */
  readonly streamFetch?: StreamFetchLike;
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
      const resetAtMs = parseProviderResetAtMs([
        res.headers.get("x-ratelimit-reset"),
        res.headers.get("x-ratelimit-reset-requests"),
        res.headers.get("x-ratelimit-reset-tokens"),
        res.headers.get("x-quota-reset"),
      ]);
      return {
        ok: res.ok,
        status: res.status,
        body: await res.text(),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(resetAtMs !== undefined ? { resetAtMs } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function parseProviderResetAtMs(headers: readonly (string | null)[], now: number = Date.now()): number | undefined {
  const parsed = headers
    .filter((value): value is string => !!value)
    .map((value) => {
      const n = Number(value);
      if (Number.isFinite(n)) {
        // Providers variously send epoch seconds, epoch milliseconds, or a
        // relative duration in seconds. Normalize all three conservatively.
        if (n > 10_000_000_000) return n;
        if (n > 1_000_000_000) return n * 1000;
        return now + Math.max(0, n) * 1000;
      }
      // Compact reset durations may combine hours/minutes/seconds and may be
      // sub-second (for example `2m59.56s` or `577ms`).
      const duration = value.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i);
      if (duration && duration[0]) {
        const hours = Number(duration[1] ?? 0);
        const minutes = Number(duration[2] ?? 0);
        const seconds = Number(duration[3] ?? 0);
        const milliseconds = Number(duration[4] ?? 0);
        return now + (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds;
      }
      const date = Date.parse(value);
      return Number.isFinite(date) ? date : undefined;
    })
    .filter((value): value is number => value !== undefined && value >= now);
  return parsed.length ? Math.max(...parsed) : undefined;
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
function exhaustionCode(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown; message?: unknown }; code?: unknown; type?: unknown };
    const fields = [parsed.code, parsed.type, parsed.error?.code, parsed.error?.type, parsed.error?.message]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    return /\b(insufficient[_ -]?quota|quota[_ -]?(exceeded|exhausted)|credits?[_ -]?(exhausted|depleted)|billing[_ -]?limit)\b/.test(fields);
  } catch {
    return false;
  }
}

function classifyStatus(status: number, host: string, body: string): Classified {
  if ((status === 402 || status === 403 || status === 429) && exhaustionCode(body)) {
    // Not retryable on this candidate; the composite runner may still route
    // the unchanged call to another candidate immediately.
    return { kind: "quota-exhausted", retryable: false, message: `${host} reported provider quota exhaustion (HTTP ${status})` };
  }
  if (status === 401 || status === 403) {
    // Invalid/expired credentials are never retryable — see providers/errors.ts's
    // ProviderAuthError for the CLI-launch equivalent of this same classification.
    return { kind: "auth", retryable: false, message: `${host} rejected credentials (HTTP ${status})` };
  }
  if (status === 429) {
    return { kind: "rate-limit", retryable: true, message: `${host} rate-limited the request (HTTP 429)` };
  }
  if (status >= 500) {
    return { kind: "server-error", retryable: true, message: `${host} returned a server error (HTTP ${status})` };
  }
  // Other 4xx (400 bad request, 404, 422, ...) is a config/payload problem —
  // retrying an identical malformed request only reproduces the same error.
  return { kind: "http-error", retryable: false, message: `${host} returned HTTP ${status}` };
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
    let resetAtMs: number | undefined;
    let ok: { status: number; body: string } | undefined;
    try {
      const res = await fetchImpl(url, init);
      if (res.ok) {
        ok = { status: res.status, body: res.body };
        classified = { kind: "http-error", retryable: false, message: "" }; // unused on success
      } else {
        classified = classifyStatus(res.status, host, res.body);
        retryAfterMs = res.retryAfterMs;
        resetAtMs = res.resetAtMs;
      }
    } catch (err) {
      classified = classifyException(err, host);
    }

    if (ok) return ok;

    const isLastAttempt = attempt === retry.maxAttempts;
    if (!classified.retryable || isLastAttempt) {
      const retryAtMs = resetAtMs ?? (retryAfterMs !== undefined ? Date.now() + retryAfterMs : undefined);
      throw new ApiAgentError(classified.message, {
        kind: classified.kind,
        host,
        retryable: classified.retryable,
        attempts: attempt,
        ...(retryAtMs !== undefined ? { retryAtMs } : {}),
      });
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
  const streamFetchImpl = deps.streamFetch ?? defaultStreamFetch(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retry = { sleep, maxAttempts, onRetry: deps.onRetry };
  const env = deps.env ?? process.env;
  // Non-secret endpoint params (e.g. a Cloudflare account id) may live in the
  // shell even when the auth credential came from the store; auth resolution
  // below still uses `env` alone, keeping the strict credential path unchanged.
  const paramEnv = { ...process.env, ...env };
  const protocol = adapter.getCapabilities().protocol;
  const model = adapter.resolveModel();

  async function call(messages: readonly AgentMessage[], tools: readonly ToolDefinition[], opts?: RunnerCallOptions): Promise<AgentTurnResult> {
    let baseUrl: string;
    try {
      baseUrl = resolveEndpointUrl(adapter.profile.baseUrl, adapter.profile, paramEnv).replace(/\/+$/, "");
    } catch (err) {
      if (err instanceof EndpointParamError) {
        // A config error (missing non-secret param), never a network failure —
        // retryable false so the failover pool does not cycle it to another
        // candidate as if the call had transiently failed.
        throw new ApiAgentError(err.message, { retryable: false });
      }
      throw err;
    }
    // Streaming is offered only for OpenAI-compatible providers and only when
    // the caller wants incremental text. A stream failure degrades to the
    // proven non-streaming path (which then emits the whole answer at once).
    if (opts?.onChunk && protocol === "openai-compatible") {
      try {
        return await openAiStreamCall(streamFetchImpl, adapter, baseUrl, model, messages, tools, env, opts);
      } catch (err) {
        if (err instanceof ApiAgentError && err.kind === "auth") throw err;
        // fall through to non-streaming
      }
    }
    const maxOutputTokens = opts?.maxOutputTokens;
    const nonStream =
      protocol === "openai-compatible"
        ? await openAiCall(fetchImpl, retry, adapter, baseUrl, model, messages, tools, env, maxOutputTokens)
        : protocol === "anthropic-messages"
          ? await anthropicCall(fetchImpl, retry, adapter, baseUrl, model, messages, tools, env, maxOutputTokens)
          : (() => { throw new ApiAgentError(`unsupported protocol: ${protocol}`); })();
    // Caller wanted streaming but the provider/path could not: hand the whole
    // answer over as a single chunk so the UX still shows generated text.
    if (opts?.onChunk && nonStream.content) opts.onChunk(nonStream.content);
    return nonStream;
  }

  return { call };
}

async function openAiStreamCall(
  streamFetch: StreamFetchLike,
  adapter: ProviderAdapter,
  baseUrl: string,
  model: string,
  messages: readonly AgentMessage[],
  tools: readonly ToolDefinition[],
  env: Readonly<Record<string, string | undefined>>,
  opts: RunnerCallOptions,
): Promise<AgentTurnResult> {
  const body = JSON.stringify({
    model,
    messages: toOpenAiWire(messages, adapter),
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
    ...(tools.length ? { tools: toOpenAiTools(tools), tool_choice: "auto" } : {}),
  });
  const headers = { "content-type": "application/json", ...adapter.profile.staticHeaders, ...adapter.buildAuthHeaders(env) };
  const url = `${baseUrl}/chat/completions`;
  const host = hostOf(url);
  const started = Date.now();
  let res: Awaited<ReturnType<StreamFetchLike>>;
  try {
    res = await streamFetch(url, { method: "POST", headers, body, ...(opts.signal ? { signal: opts.signal } : {}) });
  } catch (err) {
    throw new ApiAgentError(`${host}: ${err instanceof Error ? err.message : String(err)}`, { host, retryable: true });
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new ApiAgentError(`${host} rejected credentials (HTTP ${res.status})`, { kind: "auth", host, retryable: false });
    throw new ApiAgentError(`${host} returned HTTP ${res.status} on the streaming endpoint`, { host, retryable: res.status >= 500 });
  }
  const { result, firstTokenAt } = await consumeOpenAiStream(res.chunks, {
    onText: (delta) => opts.onChunk?.(delta),
    now: () => Date.now(),
    sourceProviderId: adapter.profile.id,
  });
  const end = Date.now();
  const requestMs = end - started;
  // decodeMs = first generated token → end of the response stream. Using the
  // stream end (not the last-delta timestamp) means TCP/read coalescing can
  // only make the measured decode window LONGER, so the derived tok/s is a
  // conservative under-estimate, never an inflated one.
  const ttftMs = firstTokenAt !== undefined ? firstTokenAt - started : undefined;
  return {
    ...result,
    timing: {
      requestMs,
      streamed: true,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      ...(firstTokenAt !== undefined ? { decodeMs: Math.max(0, end - firstTokenAt) } : {}),
    },
  };
}

function toOpenAiWire(messages: readonly AgentMessage[], adapter: ProviderAdapter): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          ...(m.content !== null ? { content: m.content } : {}),
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                  ...(tc.providerContinuation?.sourceProviderId === adapter.profile.id
                    ? { extra_content: tc.providerContinuation.openAiExtraContent }
                    : {}),
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
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
  maxOutputTokens?: number,
): Promise<AgentTurnResult> {
  const body = JSON.stringify({
    model,
    messages: toOpenAiWire(messages, adapter),
    ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
    ...(tools.length ? { tools: toOpenAiTools(tools), tool_choice: "auto" } : {}),
  });

  const headers = { "content-type": "application/json", ...adapter.profile.staticHeaders, ...adapter.buildAuthHeaders(env) };
  const started = Date.now();
  const res = await callWithRetry(fetchImpl, `${baseUrl}/chat/completions`, { method: "POST", headers, body }, retry);
  const requestMs = Date.now() - started;

  const parsed = JSON.parse(res.body) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string }; extra_content?: unknown }[] }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = parsed.choices?.[0];
  const message = choice?.message;
  const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
    ...(isRecord(tc.extra_content)
      ? { providerContinuation: { sourceProviderId: adapter.profile.id, openAiExtraContent: tc.extra_content } }
      : {}),
  }));
  return {
    content: message?.content ?? null,
    toolCalls,
    finishReason: choice?.finish_reason ?? "stop",
    ...(parsed.usage ? { usage: { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens } } : {}),
    timing: { requestMs, streamed: false },
  };
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
  maxOutputTokens?: number,
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
    max_tokens: maxOutputTokens ?? 8192,
    ...(system ? { system } : {}),
    messages: wire,
    ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
  });

  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...adapter.profile.staticHeaders, ...adapter.buildAuthHeaders(env) };
  const started = Date.now();
  const res = await callWithRetry(fetchImpl, `${baseUrl}/v1/messages`, { method: "POST", headers, body }, retry);
  const requestMs = Date.now() - started;

  const parsed = JSON.parse(res.body) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  for (const block of parsed.content ?? []) {
    if (block.type === "text" && block.text) textParts.push(block.text);
    else if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return {
    content: textParts.length ? textParts.join("\n") : null,
    toolCalls,
    finishReason: parsed.stop_reason ?? "end_turn",
    ...(parsed.usage ? { usage: { promptTokens: parsed.usage.input_tokens, completionTokens: parsed.usage.output_tokens } } : {}),
    timing: { requestMs, streamed: false },
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
