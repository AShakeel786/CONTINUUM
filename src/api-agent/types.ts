/**
 * Provider-independent API agent message/tool representation. Both OpenAI- and
 * Anthropic-compatible runners convert THIS shape to their wire format, so the
 * agent loop never knows which protocol it's talking to (capability-driven,
 * no provider-id branch).
 */

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON-encoded arguments string (as the wire protocol carries it). */
  readonly arguments: string;
  /**
   * Opaque OpenAI-compatible continuation fields required by the provider
   * that issued this call (for example a reasoning/thought signature). They
   * remain part of logical history but are replayed only to the same provider,
   * so failover never sends provider-private fields to a replacement.
   */
  readonly providerContinuation?: {
    readonly sourceProviderId: string;
    readonly openAiExtraContent: Readonly<Record<string, unknown>>;
  };
}

export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: readonly AgentToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface AgentTurnResult {
  readonly content: string | null;
  readonly toolCalls: readonly AgentToolCall[];
  readonly finishReason: string;
}

export interface AgentLoopLimits {
  /** Maximum model→tool iterations before a forced (graceful) stop. */
  readonly maxIterations: number;
  /** Wall-clock timeout for the whole loop. */
  readonly timeoutMs: number;
  /**
   * How many times the same tool call (name + normalized arguments) may
   * produce a materially-equivalent result before the loop injects a stall
   * signal telling the model to converge. Default 3.
   */
  readonly stallThreshold?: number;
  /**
   * How many stall signals to inject before giving up and returning a partial
   * answer rather than burning the rest of `maxIterations`. Default 2.
   */
  readonly maxStallSignals?: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLoopLimits = {
  maxIterations: 25,
  timeoutMs: 10 * 60_000,
  stallThreshold: 3,
  maxStallSignals: 2,
};

/** Why the agent loop stopped. `final` = the model produced an answer with no tool calls. */
export type AgentStopReason = "final" | "max-iterations" | "timeout" | "stalled";

/**
 * Raised only for a genuinely unexpected loop fault. `max-iterations` /
 * `timeout` / `stalled` are NOT thrown — the loop returns a graceful partial
 * result (see `AgentLoopResult.stopReason`) so the caller can surface
 * accumulated findings instead of a bare "loop exceeded N iterations".
 * Retained for backwards compatibility and for callers that still catch it.
 */
export class AgentLoopError extends Error {
  readonly reason: "max-iterations" | "timeout";
  constructor(reason: "max-iterations" | "timeout", detail: string) {
    super(detail);
    this.name = "AgentLoopError";
    this.reason = reason;
  }
}

/**
 * How a failed API call was classified — mirrors the distinctions the
 * health layer already makes for local dependencies (checks.ts), applied
 * here to CONTINUUM's own direct-API HTTP client (runner.ts). Only
 * "dns" | "connection-refused" | "timeout" | "rate-limit" | "server-error"
 * are ever retried; "tls" | "auth" | "http-error" are config/credential
 * problems a retry cannot fix.
 */
export type NetworkFailureKind = "dns" | "connection-refused" | "timeout" | "tls" | "auth" | "rate-limit" | "quota-exhausted" | "server-error" | "http-error";

export class ApiAgentError extends Error {
  readonly kind?: NetworkFailureKind;
  /** `host:port` only — never the full URL with query/path that could carry incidental data. */
  readonly host?: string;
  readonly retryable: boolean;
  readonly attempts?: number;
  /** Absolute epoch timestamp at which this candidate may be retried. */
  readonly retryAtMs?: number;
  constructor(detail: string, opts?: { kind?: NetworkFailureKind; host?: string; retryable?: boolean; attempts?: number; retryAtMs?: number }) {
    super(detail);
    this.name = "ApiAgentError";
    this.kind = opts?.kind;
    this.host = opts?.host;
    this.retryable = opts?.retryable ?? false;
    this.attempts = opts?.attempts;
    this.retryAtMs = opts?.retryAtMs;
  }
}
