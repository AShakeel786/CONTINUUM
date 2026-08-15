import { describe, expect, it } from "vitest";
import { parseCacheTelemetry } from "../telemetry.js";

describe("parseCacheTelemetry — Anthropic protocol (real field mapping, verified against MemoryProxy/src/credit-reporter.ts)", () => {
  it("parses a real cache-hit response correctly (input_tokens excludes cache, per Anthropic's own contract)", () => {
    const telemetry = parseCacheTelemetry("anthropic-messages", {
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    });
    expect(telemetry.available).toBe(true);
    if (telemetry.available) {
      expect(telemetry.inputTokens).toBe(950); // 50 fresh + 900 cache-read + 0 cache-write
      expect(telemetry.cachedTokens).toBe(900);
      expect(telemetry.freshTokens).toBe(50);
      expect(telemetry.cacheWriteTokens).toBe(0);
      expect(telemetry.cacheHitRate).toBeCloseTo(900 / 950, 5);
      expect(telemetry.estimatedSavingsTokens).toBe(900);
      expect(telemetry.source).toBe("provider-reported");
    }
  });

  it("parses a cache-write (first turn, no hit yet) response correctly", () => {
    const telemetry = parseCacheTelemetry("anthropic-messages", {
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 800,
    });
    expect(telemetry.available).toBe(true);
    if (telemetry.available) {
      expect(telemetry.cachedTokens).toBe(0);
      expect(telemetry.cacheWriteTokens).toBe(800);
      expect(telemetry.cacheHitRate).toBe(0);
    }
  });

  it("reports unavailable (not fabricated zeros) when the response has no usage fields at all", () => {
    const telemetry = parseCacheTelemetry("anthropic-messages", {});
    expect(telemetry.available).toBe(false);
  });

  it("reports unavailable when usage is null/undefined", () => {
    expect(parseCacheTelemetry("anthropic-messages", null).available).toBe(false);
    expect(parseCacheTelemetry("anthropic-messages", undefined).available).toBe(false);
  });
});

describe("parseCacheTelemetry — DeepSeek / OpenAI-compatible protocol (verified DeepSeek cache behavior)", () => {
  it("parses a real DeepSeek cache-hit response (prompt_cache_hit style: cache_read_tokens field)", () => {
    const telemetry = parseCacheTelemetry("openai-compatible", {
      prompt_tokens: 1000,
      completion_tokens: 40,
      cache_read_tokens: 700,
    });
    expect(telemetry.available).toBe(true);
    if (telemetry.available) {
      expect(telemetry.inputTokens).toBe(1000); // prompt_tokens already INCLUDES cache (differs from Anthropic)
      expect(telemetry.cachedTokens).toBe(700);
      expect(telemetry.freshTokens).toBe(300);
      expect(telemetry.cacheWriteTokens).toBeUndefined(); // no cache-write concept for this protocol
      expect(telemetry.cacheHitRate).toBeCloseTo(0.7, 5);
    }
  });

  it("falls back to prompt_tokens_details.cached_tokens (alternate DeepSeek/OpenAI field naming)", () => {
    const telemetry = parseCacheTelemetry("openai-compatible", {
      prompt_tokens: 500,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 200 },
    });
    expect(telemetry.available).toBe(true);
    if (telemetry.available) {
      expect(telemetry.cachedTokens).toBe(200);
      expect(telemetry.freshTokens).toBe(300);
    }
  });

  it("handles zero cache hit (cold cache) without treating it as unavailable", () => {
    const telemetry = parseCacheTelemetry("openai-compatible", { prompt_tokens: 400, completion_tokens: 5 });
    expect(telemetry.available).toBe(true);
    if (telemetry.available) {
      expect(telemetry.cachedTokens).toBe(0);
      expect(telemetry.cacheHitRate).toBe(0);
    }
  });

  it("reports unavailable when there is no prompt_tokens and no cache fields at all", () => {
    const telemetry = parseCacheTelemetry("openai-compatible", { completion_tokens: 5 });
    expect(telemetry.available).toBe(false);
  });
});
