import type { ProviderPricingSchedule } from "../types.js";
import { deepseekPricingSchedule } from "./deepseek.js";

/**
 * Default schedule registry — mirrors `createDefaultProviderRegistry()`
 * (src/providers/index.ts): a small, explicit map, not a config file scan.
 * Only providers with a genuinely known pricing schedule are listed —
 * Claude has no peak/off-peak concept in this codebase, so it's absent,
 * not defaulted to "always off-peak."
 */
export function createDefaultPricingSchedules(): ReadonlyMap<string, ProviderPricingSchedule> {
  return new Map([[deepseekPricingSchedule.providerId, deepseekPricingSchedule]]);
}

export { deepseekPricingSchedule };
