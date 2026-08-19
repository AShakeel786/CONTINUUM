import { describe, expect, it } from "vitest";
import { estimateCostUsd, evaluateRollover } from "../calculator.js";
const usage = { inputTokens: 350_000, cacheHitTokens: 340_000, cacheMissTokens: 10_000, outputTokens: 1_000, contextTokens: 350_000, turns: 1 };
describe("DeepSeek cost and rollover math", () => {
  it("prices hit, miss, output, and peak multiplier separately", () => expect(estimateCostUsd(usage, "deepseek-v4-pro", 2)).toBeCloseTo(2 * (340_000 * .022 + 10_000 * .66 + 1_000 * 1.98) / 1_000_000));
  it("includes fresh handoff miss cost", () => {
    expect(evaluateRollover(usage, "deepseek-v4-pro", { mode: "automatic", contextTokenThreshold: 100_000, expectedRemainingTurns: 8, handoffTokens: 8_000, minimumSavingsUsd: 0 }).rollover).toBe(true);
    expect(evaluateRollover({ ...usage, contextTokens: 20_000 }, "deepseek-v4-pro").rollover).toBe(false);
  });
  it("supports a deterministic token threshold", () => expect(evaluateRollover(usage, "deepseek-v4-pro", { mode: "tokens", contextTokenThreshold: 350_000, expectedRemainingTurns: 1, handoffTokens: 8_000, minimumSavingsUsd: 999 }).rollover).toBe(true));
});
