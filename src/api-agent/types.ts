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
  /** Maximum model→tool iterations before a forced stop. */
  readonly maxIterations: number;
  /** Wall-clock timeout for the whole loop. */
  readonly timeoutMs: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLoopLimits = { maxIterations: 25, timeoutMs: 10 * 60_000 };

/** Raised when the loop would exceed its bounds — never an unbounded run. */
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
export type NetworkFailureKind = "dns" | "connection-refused" | "timeout" | "tls" | "auth" | "rate-limit" | "server-error" | "http-error";

export class ApiAgentError extends Error {
  readonly kind?: NetworkFailureKind;
  /** `host:port` only — never the full URL with query/path that could carry incidental data. */
  readonly host?: string;
  readonly retryable: boolean;
  readonly attempts?: number;
  constructor(detail: string, opts?: { kind?: NetworkFailureKind; host?: string; retryable?: boolean; attempts?: number }) {
    super(detail);
    this.name = "ApiAgentError";
    this.kind = opts?.kind;
    this.host = opts?.host;
    this.retryable = opts?.retryable ?? false;
    this.attempts = opts?.attempts;
  }
}
