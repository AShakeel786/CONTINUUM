/**
 * Cache telemetry parsing — from a real provider response's `usage` block
 * only. Field mapping is not guessed: it matches
 * `MemoryProxy/src/credit-reporter.ts`'s `computeCreditDelta`, which is
 * real, in-production billing code already parsing these exact fields from
 * live Anthropic and DeepSeek (OpenAI-compatible) responses.
 *
 * Anthropic protocol (`input_tokens` already EXCLUDES cache, per Anthropic's
 * own API contract — this differs from the OpenAI branch below, where
 * `prompt_tokens` INCLUDES cache):
 *   - freshTokens    = usage.input_tokens
 *   - cachedTokens   = usage.cache_read_input_tokens
 *   - cacheWriteTokens = usage.cache_creation_input_tokens
 *
 * DeepSeek / OpenAI-compatible protocol:
 *   - cachedTokens   = usage.cache_read_tokens ?? usage.prompt_tokens_details.cached_tokens
 *   - freshTokens    = max(0, usage.prompt_tokens - cachedTokens)
 *   - no cache-write concept (DeepSeek's caching is automatic/server-side —
 *     matches its "openai-automatic" capability from Phase 3; there is
 *     nothing to report as "written" from the client's perspective)
 */

import type { Protocol } from "../providers/types.js";
import type { CacheTelemetry } from "./types.js";

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseAnthropicUsage(usage: Readonly<Record<string, unknown>>): CacheTelemetry {
  const hasCacheFields = "cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage;
  if (!hasCacheFields && !("input_tokens" in usage)) {
    return { available: false, reason: "response usage block has no Anthropic cache or input_tokens fields" };
  }

  const freshTokens = numField(usage.input_tokens);
  const cachedTokens = numField(usage.cache_read_input_tokens);
  const cacheWriteTokens = numField(usage.cache_creation_input_tokens);
  const inputTokens = freshTokens + cachedTokens + cacheWriteTokens;

  return {
    available: true,
    inputTokens,
    cachedTokens,
    freshTokens,
    cacheWriteTokens,
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    estimatedSavingsTokens: cachedTokens,
    source: "provider-reported",
  };
}

function parseOpenAiCompatibleUsage(usage: Readonly<Record<string, unknown>>): CacheTelemetry {
  const promptTokensDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = numField(usage.cache_read_tokens) || numField(promptTokensDetails?.cached_tokens);
  const promptTokens = numField(usage.prompt_tokens);

  if (promptTokens === 0 && cachedTokens === 0) {
    return { available: false, reason: "response usage block has no prompt_tokens or cache fields" };
  }

  const freshTokens = Math.max(0, promptTokens - cachedTokens);

  return {
    available: true,
    inputTokens: promptTokens,
    cachedTokens,
    freshTokens,
    // No cacheWriteTokens field at all (not 0) — DeepSeek's OpenAI-compatible
    // usage shape has no cache-write concept to report, per credit-reporter.ts's
    // own comment: "OpenAI 协议...无 cache write 概念".
    cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
    estimatedSavingsTokens: cachedTokens,
    source: "provider-reported",
  };
}

export function parseCacheTelemetry(protocol: Protocol, usage: Readonly<Record<string, unknown>> | null | undefined): CacheTelemetry {
  if (!usage) return { available: false, reason: "no usage block in provider response" };
  return protocol === "anthropic-messages" ? parseAnthropicUsage(usage) : parseOpenAiCompatibleUsage(usage);
}
