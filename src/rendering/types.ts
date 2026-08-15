import type { CacheDirective } from "../cache/types.js";
import type { Protocol } from "../providers/types.js";

/** Anthropic Messages API system content block — verified wire shape (Phase 3's own AnthropicLLMRunner tests confirmed `system` is sent as `[{type:"text", text}]`, not a raw string). */
export interface AnthropicSystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
}

/**
 * A rendered, provider-shaped context fragment — ready to merge into that
 * provider's actual request. Rendering only serializes; it never changes
 * *what* content exists (that's decided once, in the ContextEnvelope).
 */
export interface RenderedContext {
  readonly protocol: Protocol;
  /**
   * Anthropic: an array of content blocks, one per stable ContextBlock, so
   * a cache_control marker can attach to the exact block Anthropic's API
   * expects it on. OpenAI-compatible (DeepSeek): a single joined string —
   * that protocol has no per-block cache concept, so there's nothing to
   * preserve block boundaries for.
   */
  readonly system: readonly AnthropicSystemBlock[] | string;
  /** Dynamic content, joined, meant to prepend the caller's own user-turn text. */
  readonly userPrefix: string;
  readonly cacheDirectives: readonly CacheDirective[];
}
