import type { ModelPrices, TokenUsageEstimate } from "./types.js";

/**
 * DeepSeek USD list prices, from DeepSeek's official pricing page
 * (https://api-docs.deepseek.com/quick_start/pricing — the same official
 * source this table always used; the page publishes its tariffs in USD, so
 * no FX conversion is ever applied to RMB figures from the Chinese-market
 * page). Values below are the OFF-PEAK base rates; the pricing schedule's
 * 2× peak multiplier (see src/pricing/schedules/deepseek.ts) applies during
 * the published Monday–Friday UTC peak windows.
 *
 * September 2026 state:
 * - `deepseek-flash` IS DeepSeek V4.1 Flash (canonical API id; the
 *   `deepseek-v4.1-flash` spelling is NOT a valid API model name).
 * - Legacy `deepseek-v4-flash` requests are served by V4.1 Flash and billed
 *   at the V4.1 Flash rates.
 * - `deepseek-v4-pro` requests are currently ALSO routed to V4.1 Flash
 *   (until V4.1 Pro launches), so they are billed at the V4.1 Flash rates
 *   today — see `effectivePricingModel`. The historical V4 Pro tariff is
 *   kept here only so V4.1 Pro pricing can be restored cleanly when
 *   DeepSeek actually launches it; nothing consults it while Pro is routed
 *   to Flash.
 */
export const DEEPSEEK_USD_PRICES: Readonly<Record<string, ModelPrices>> = {
  // DeepSeek V4.1 Flash — official USD off-peak (peak = 2×).
  "deepseek-flash": { cacheHitPerMillion: 0.003, cacheMissPerMillion: 0.15, outputPerMillion: 0.6 },
  // Dormant: historical V4 Pro tariff (off-peak). Re-activate via
  // `effectivePricingModel` only when DeepSeek launches a genuinely
  // distinct V4.1 Pro model.
  "deepseek-v4-pro": { cacheHitPerMillion: 0.022, cacheMissPerMillion: 0.66, outputPerMillion: 1.98 },
};

/**
 * The canonical model id whose tariff currently applies to `model`, given
 * DeepSeek's present upstream routing:
 * - the Claude Code `[1m]` context suffix is client metadata, not part of
 *   the DeepSeek id — stripped before any lookup;
 * - legacy `deepseek-v4-flash` → canonical `deepseek-flash`;
 * - `deepseek-v4-pro` → `deepseek-flash` (DeepSeek routes Pro requests to
 *   V4.1 Flash until V4.1 Pro launches, and bills them at Flash rates);
 * - anything else passes through unchanged.
 */
export function effectivePricingModel(model: string): string {
  const bare = model.replace(/\[1m\]$/, "");
  if (bare === "deepseek-v4-flash") return "deepseek-flash";
  if (bare === "deepseek-v4-pro") return "deepseek-flash";
  return bare;
}

export function estimateCostUsd(usage: TokenUsageEstimate, model: string, multiplier = 1): number {
  const p = DEEPSEEK_USD_PRICES[effectivePricingModel(model)];
  if (!p) return 0;
  return multiplier * ((usage.cacheHitTokens * p.cacheHitPerMillion + usage.cacheMissTokens * p.cacheMissPerMillion + usage.outputTokens * p.outputPerMillion) / 1_000_000);
}

export interface RolloverPolicy { readonly mode: "automatic" | "tokens" | "off"; readonly contextTokenThreshold: number; readonly expectedRemainingTurns: number; readonly handoffTokens: number; readonly minimumSavingsUsd: number; }
export const DEFAULT_ROLLOVER_POLICY: RolloverPolicy = { mode: "automatic", contextTokenThreshold: 180_000, expectedRemainingTurns: 8, handoffTokens: 8_000, minimumSavingsUsd: 0.01 };

export function evaluateRollover(usage: TokenUsageEstimate, model: string, policy: RolloverPolicy = DEFAULT_ROLLOVER_POLICY, multiplier = 1) {
  if (policy.mode === "off") return { rollover: false, estimatedAvoidedUsd: 0, reason: "rollover disabled" };
  const p = DEEPSEEK_USD_PRICES[effectivePricingModel(model)];
  if (!p) return { rollover: false, estimatedAvoidedUsd: 0, reason: "no pricing data" };
  const tokenTriggered = usage.contextTokens >= policy.contextTokenThreshold;
  const continueCost = usage.contextTokens * policy.expectedRemainingTurns * p.cacheHitPerMillion;
  const freshCost = policy.handoffTokens * p.cacheMissPerMillion + policy.handoffTokens * Math.max(0, policy.expectedRemainingTurns - 1) * p.cacheHitPerMillion;
  const avoided = Math.max(0, ((continueCost - freshCost) * multiplier) / 1_000_000);
  const rollover = policy.mode === "tokens" ? tokenTriggered : tokenTriggered && avoided >= policy.minimumSavingsUsd;
  return { rollover, estimatedAvoidedUsd: avoided, reason: rollover ? `context ${usage.contextTokens} tokens; estimated future cache-read cost avoided $${avoided.toFixed(4)}` : `below ${policy.mode === "tokens" ? "token" : "cost"} threshold` };
}
