import type { Protocol } from "../providers/types.js";

/** Standard Anthropic Messages API prompt-cache breakpoint marker. Public API contract — the only documented form (optionally with a `ttl`, not used here; see directives.ts). */
export interface AnthropicCacheControl {
  readonly type: "ephemeral";
}

export interface CacheDirective {
  readonly blockId: string;
  readonly marker: AnthropicCacheControl;
}

export interface RawProviderUsage {
  readonly protocol: Protocol;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * Cache telemetry, only ever built from a real provider response's usage
 * block (Phase 4 requirement: "do not fake cache-hit numbers"). When a
 * provider's response carries no usable cache fields, callers get
 * `{ available: false }`, never a fabricated zero.
 */
export type CacheTelemetry =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly inputTokens: number;
      readonly cachedTokens: number;
      readonly freshTokens: number;
      /** Anthropic only — tokens written to cache this call. Absent (not 0) for protocols with no cache-write concept. */
      readonly cacheWriteTokens?: number;
      readonly cacheHitRate: number;
      /**
       * Tokens served from cache rather than freshly processed — the
       * honest, provider-reported quantity behind "savings". Deliberately
       * NOT a dollar figure: CONTINUUM has no authoritative multi-provider
       * pricing table, and inventing one to produce a $ number would be
       * exactly the kind of fabrication the brief rules out.
       */
      readonly estimatedSavingsTokens: number;
      readonly source: "provider-reported";
    };

export interface PrefixStabilityResult {
  readonly stable: boolean;
  readonly invalidationReason?: string;
  readonly currentHash: string;
  readonly previousHash?: string;
}
