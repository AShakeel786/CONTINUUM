import type { ModelPrices, TokenUsageEstimate } from "./types.js";

export const DEEPSEEK_USD_PRICES: Readonly<Record<string, ModelPrices>> = {
  // Official USD off-peak list prices; the schedule's 2× multiplier applies during peak.
  "deepseek-v4-flash": { cacheHitPerMillion: 0.007, cacheMissPerMillion: 0.22, outputPerMillion: 0.66 },
  "deepseek-v4-pro": { cacheHitPerMillion: 0.022, cacheMissPerMillion: 0.66, outputPerMillion: 1.98 },
};

export function estimateCostUsd(usage: TokenUsageEstimate, model: string, multiplier = 1): number {
  const p = DEEPSEEK_USD_PRICES[model];
  if (!p) return 0;
  return multiplier * ((usage.cacheHitTokens * p.cacheHitPerMillion + usage.cacheMissTokens * p.cacheMissPerMillion + usage.outputTokens * p.outputPerMillion) / 1_000_000);
}

export interface RolloverPolicy { readonly mode: "automatic" | "tokens" | "off"; readonly contextTokenThreshold: number; readonly expectedRemainingTurns: number; readonly handoffTokens: number; readonly minimumSavingsUsd: number; }
export const DEFAULT_ROLLOVER_POLICY: RolloverPolicy = { mode: "automatic", contextTokenThreshold: 180_000, expectedRemainingTurns: 8, handoffTokens: 8_000, minimumSavingsUsd: 0.01 };

export function evaluateRollover(usage: TokenUsageEstimate, model: string, policy: RolloverPolicy = DEFAULT_ROLLOVER_POLICY, multiplier = 1) {
  if (policy.mode === "off") return { rollover: false, estimatedAvoidedUsd: 0, reason: "rollover disabled" };
  const p = DEEPSEEK_USD_PRICES[model];
  if (!p) return { rollover: false, estimatedAvoidedUsd: 0, reason: "no pricing data" };
  const tokenTriggered = usage.contextTokens >= policy.contextTokenThreshold;
  const continueCost = usage.contextTokens * policy.expectedRemainingTurns * p.cacheHitPerMillion;
  const freshCost = policy.handoffTokens * p.cacheMissPerMillion + policy.handoffTokens * Math.max(0, policy.expectedRemainingTurns - 1) * p.cacheHitPerMillion;
  const avoided = Math.max(0, ((continueCost - freshCost) * multiplier) / 1_000_000);
  const rollover = policy.mode === "tokens" ? tokenTriggered : tokenTriggered && avoided >= policy.minimumSavingsUsd;
  return { rollover, estimatedAvoidedUsd: avoided, reason: rollover ? `context ${usage.contextTokens} tokens; estimated future cache-read cost avoided $${avoided.toFixed(4)}` : `below ${policy.mode === "tokens" ? "token" : "cost"} threshold` };
}
