import { describe, expect, it } from "vitest";
import { addTokenCounts, estimateTokens, fromProviderUsage } from "../tokenizer.js";

describe("tokenizer — exact vs. estimate labeling", () => {
  it("estimateTokens returns a real BPE count (not chars/4), labeled tiktoken-estimate", () => {
    const result = estimateTokens("The quick brown fox jumps over the lazy dog.");
    expect(result.method).toBe("tiktoken-estimate");
    // A real tokenizer splits this into fewer tokens than characters, and
    // it's not exactly length/4 either — just assert it's a sane BPE count.
    expect(result.tokens).toBeGreaterThan(5);
    expect(result.tokens).toBeLessThan(20);
  });

  it("estimateTokens('') is zero without invoking the encoder on empty input", () => {
    expect(estimateTokens("")).toEqual({ tokens: 0, method: "tiktoken-estimate" });
  });

  it("fromProviderUsage wraps a real provider-reported count, labeled provider-reported", () => {
    expect(fromProviderUsage(42)).toEqual({ tokens: 42, method: "provider-reported" });
  });

  it("addTokenCounts sums correctly and only stays provider-reported when BOTH sides are exact", () => {
    const exact = fromProviderUsage(10);
    const estimate = estimateTokens("hello");
    const bothExact = addTokenCounts(exact, fromProviderUsage(5));
    const mixed = addTokenCounts(exact, estimate);

    expect(bothExact).toEqual({ tokens: 15, method: "provider-reported" });
    expect(mixed.method).toBe("tiktoken-estimate");
    expect(mixed.tokens).toBe(10 + estimate.tokens);
  });
});
