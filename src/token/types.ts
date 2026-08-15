import type { ContentClass, ContextEnvelope } from "../context/types.js";

/**
 * A token count, always labeled with how it was obtained. Never presented
 * as a bare number — "exact vs estimated" must survive to every consumer
 * (Phase 4 requirement: "clearly distinguish exact counts from estimates").
 */
export interface TokenCount {
  readonly tokens: number;
  /**
   * "provider-reported": from a real API response's usage block (only
   * available post-call, for output/input-actually-sent accounting).
   * "tiktoken-estimate": pre-flight count via js-tiktoken — a real BPE
   * tokenizer, not a chars/4 guess, but not guaranteed byte-identical to
   * Claude's or DeepSeek's own (unpublished) tokenizers.
   */
  readonly method: "provider-reported" | "tiktoken-estimate";
}

export interface TokenLimits {
  /** Total context window for the target model. */
  readonly contextWindow: number;
  /** Tokens to reserve for the model's own output — never counted as available for input. */
  readonly reservedOutput: number;
}

export type TrimAction = "truncated" | "dropped";

export interface TrimEvent {
  readonly blockId: string;
  readonly class: ContentClass;
  readonly action: TrimAction;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly reason: string;
}

export interface TokenBudgetResult {
  readonly envelope: ContextEnvelope;
  readonly inputTokensBefore: TokenCount;
  readonly inputTokensAfter: TokenCount;
  readonly availableForInput: number;
  readonly trimEvents: readonly TrimEvent[];
  /**
   * True when even the untouchable content (the "instructions" class, plus
   * any block the caller marks critical) alone exceeds `availableForInput`.
   * The budget was NOT enforced in this case — see
   * PHASE_4_CACHE_TOKEN_REPORT.md for why silently truncating instructions
   * was rejected as an option (Phase 4 requirement: "never silently
   * truncate critical instructions").
   */
  readonly criticalContentOverBudget: boolean;
}
