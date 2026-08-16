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

export class ApiAgentError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ApiAgentError";
  }
}
