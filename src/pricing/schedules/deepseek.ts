import type { ProviderPricingSchedule } from "../types.js";

/**
 * DeepSeek's official peak-pricing schedule (September 2026). Pure data —
 * if DeepSeek changes its published schedule, update this file only; the
 * calculator (`../calculator.ts`) has no DeepSeek-specific logic to touch.
 *
 * Peak windows are Monday–Friday ONLY (everything else — including the
 * whole weekend — is off-peak), evaluated in UTC. Never store local
 * (Toronto) wall-clock equivalents here: DST shifts them, so the calculator
 * always reasons in UTC and only the display layer converts to a local
 * timezone.
 */
export const deepseekPricingSchedule: ProviderPricingSchedule = {
  providerId: "deepseek",
  peakWindows: [
    { startUTC: "01:00", endUTC: "04:00" },
    { startUTC: "06:00", endUTC: "10:00" },
  ],
  // getUTCDay(): 1=Monday … 5=Friday.
  peakDaysUTC: [1, 2, 3, 4, 5],
  peakMultiplier: 2,
  source:
    "DeepSeek official pricing page (api-docs.deepseek.com/quick_start/pricing, September 2026): peak 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday; off-peak rates are half of peak; everything else off-peak.",
};
