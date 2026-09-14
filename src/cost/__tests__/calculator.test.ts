import { describe, expect, it } from "vitest";
import { DEEPSEEK_USD_PRICES, effectivePricingModel, estimateCostUsd, evaluateRollover } from "../calculator.js";

const usage = { inputTokens: 350_000, cacheHitTokens: 340_000, cacheMissTokens: 10_000, outputTokens: 1_000, contextTokens: 350_000, turns: 1 };

// Official DeepSeek V4.1 Flash USD off-peak rates (peak = 2×) — September 2026.
const FLASH = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };
const PRO_ARCHIVAL = { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 };

describe("DeepSeek V4.1 Flash pricing table (official USD)", () => {
  it("stores the official off-peak V4.1 Flash rates under the canonical deepseek-flash id", () => {
    expect(DEEPSEEK_USD_PRICES["deepseek-flash"]).toEqual({ cacheHitPerMillion: FLASH.cacheHit, cacheMissPerMillion: FLASH.cacheMiss, outputPerMillion: FLASH.output });
  });

  it("keeps the archival V4 Pro tariff for a future genuinely-distinct V4.1 Pro (not consulted while Pro is routed to Flash)", () => {
    expect(DEEPSEEK_USD_PRICES["deepseek-v4-pro"]).toEqual({ cacheHitPerMillion: PRO_ARCHIVAL.cacheHit, cacheMissPerMillion: PRO_ARCHIVAL.cacheMiss, outputPerMillion: PRO_ARCHIVAL.output });
  });

  it("no production id resolves to a nonexistent deepseek-v4.1-flash tariff", () => {
    expect(DEEPSEEK_USD_PRICES["deepseek-v4.1-flash"]).toBeUndefined();
    expect(effectivePricingModel("deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
  });
});

describe("effectivePricingModel — current upstream routing", () => {
  it("canonical deepseek-flash prices as itself", () => {
    expect(effectivePricingModel("deepseek-flash")).toBe("deepseek-flash");
  });

  it("legacy deepseek-v4-flash is billed as the canonical deepseek-flash", () => {
    expect(effectivePricingModel("deepseek-v4-flash")).toBe("deepseek-flash");
  });

  it("deepseek-v4-pro is currently routed to V4.1 Flash and billed at Flash rates", () => {
    expect(effectivePricingModel("deepseek-v4-pro")).toBe("deepseek-flash");
  });

  it("strips the Claude Code [1m] context suffix before pricing", () => {
    expect(effectivePricingModel("deepseek-flash[1m]")).toBe("deepseek-flash");
    expect(effectivePricingModel("deepseek-v4-pro[1m]")).toBe("deepseek-flash");
  });
});

describe("DeepSeek cost and rollover math (V4.1 Flash rates)", () => {
  it("prices hit, miss, output, and peak multiplier separately at Flash rates", () => {
    expect(estimateCostUsd(usage, "deepseek-flash", 2)).toBeCloseTo(2 * (340_000 * FLASH.cacheHit + 10_000 * FLASH.cacheMiss + 1_000 * FLASH.output) / 1_000_000);
  });

  it("a deepseek-v4-pro request is estimated at V4.1 Flash rates, not the archival Pro rates", () => {
    expect(estimateCostUsd(usage, "deepseek-v4-pro", 2)).toBeCloseTo(estimateCostUsd(usage, "deepseek-flash", 2));
    expect(estimateCostUsd(usage, "deepseek-v4-pro", 2)).not.toBeCloseTo(2 * (340_000 * PRO_ARCHIVAL.cacheHit + 10_000 * PRO_ARCHIVAL.cacheMiss + 1_000 * PRO_ARCHIVAL.output) / 1_000_000);
  });

  it("a legacy deepseek-v4-flash request is estimated at V4.1 Flash rates", () => {
    expect(estimateCostUsd(usage, "deepseek-v4-flash")).toBeCloseTo(estimateCostUsd(usage, "deepseek-flash"));
  });

  it("includes fresh handoff miss cost", () => {
    expect(evaluateRollover(usage, "deepseek-flash", { mode: "automatic", contextTokenThreshold: 100_000, expectedRemainingTurns: 8, handoffTokens: 8_000, minimumSavingsUsd: 0 }).rollover).toBe(true);
    expect(evaluateRollover({ ...usage, contextTokens: 20_000 }, "deepseek-flash").rollover).toBe(false);
  });

  it("supports a deterministic token threshold", () => expect(evaluateRollover(usage, "deepseek-flash", { mode: "tokens", contextTokenThreshold: 350_000, expectedRemainingTurns: 1, handoffTokens: 8_000, minimumSavingsUsd: 999 }).rollover).toBe(true));

  it("rollover for a deepseek-v4-pro request uses Flash rates too", () => {
    const pro = evaluateRollover(usage, "deepseek-v4-pro", { mode: "automatic", contextTokenThreshold: 100_000, expectedRemainingTurns: 8, handoffTokens: 8_000, minimumSavingsUsd: 0 });
    const flash = evaluateRollover(usage, "deepseek-flash", { mode: "automatic", contextTokenThreshold: 100_000, expectedRemainingTurns: 8, handoffTokens: 8_000, minimumSavingsUsd: 0 });
    expect(pro).toEqual(flash);
  });
});
