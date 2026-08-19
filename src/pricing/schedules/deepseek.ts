import type { ProviderPricingSchedule } from "../types.js";

/**
 * DeepSeek's official peak-pricing windows, as of this phase. Pure data —
 * if DeepSeek changes its published schedule, update this file only; the
 * calculator (`../calculator.ts`) has no DeepSeek-specific logic to touch.
 */
export const deepseekPricingSchedule: ProviderPricingSchedule = {
  providerId: "deepseek",
  peakWindows: [
    { startUTC: "01:00", endUTC: "04:00" },
    { startUTC: "06:00", endUTC: "10:00" },
  ],
  peakMultiplier: 2,
  source: "DeepSeek official pricing page: separate off-peak/peak rates, 2× peak; windows 01:00–04:00 UTC and 06:00–10:00 UTC.",
};
