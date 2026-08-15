/**
 * Token counting. Two distinct paths, matching `TokenCount.method`:
 *
 * - `estimate()` — pre-flight, via `js-tiktoken`'s `o200k_base` encoding.
 *   This is the exact same library and encoding MemoryCore already uses
 *   internally (`MemoryCore/src/offload-client/token-estimator.ts`,
 *   `src/offload_server/compact/compressor.ts`) — a real BPE tokenizer, not
 *   a chars/4 heuristic. It is still an *estimate* for Claude/DeepSeek: `
 *   neither publishes a tokenizer confirmed byte-identical to OpenAI's
 *   o200k_base encoding, so the count is labeled `tiktoken-estimate`, never
 *   `provider-reported`, regardless of which provider it's estimating for.
 * - `fromProviderUsage()` — post-call, wraps a real API response's usage
 *   block. This is the actually-exact count, only available after the call
 *   already happened (see src/cache/telemetry.ts, which reads the same
 *   provider usage data for cache hit/miss reporting).
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { TokenCount } from "./types.js";

const ENCODING_NAME = "o200k_base";

let cachedEncoder: Tiktoken | undefined;

function encoder(): Tiktoken {
  if (!cachedEncoder) cachedEncoder = getEncoding(ENCODING_NAME);
  return cachedEncoder;
}

export function estimateTokens(text: string): TokenCount {
  if (!text) return { tokens: 0, method: "tiktoken-estimate" };
  const tokens = encoder().encode(text).length;
  return { tokens, method: "tiktoken-estimate" };
}

export function fromProviderUsage(tokens: number): TokenCount {
  return { tokens, method: "provider-reported" };
}

export function addTokenCounts(a: TokenCount, b: TokenCount): TokenCount {
  return {
    tokens: a.tokens + b.tokens,
    // If either side is an estimate, the sum can only honestly be labeled
    // an estimate too — "exact" only when every contributor was exact.
    method: a.method === "provider-reported" && b.method === "provider-reported" ? "provider-reported" : "tiktoken-estimate",
  };
}
