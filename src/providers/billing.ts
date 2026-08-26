/**
 * Billing-class helpers — pure, deterministic, no I/O. Single source of truth
 * for "is this provider free-only pool eligible" shared by the failover pool,
 * the launcher's automatic picker, and the CLI status surfaces.
 *
 * The pool rule is deliberately strict: a provider joins the automatic
 * free-only pool ONLY when its billing class is `free` AND its free tier is
 * declared pool-eligible (`freeOnlyEligible !== false`). `trial` and `paid`
 * classes, and free providers whose hard-stop cannot be proven for the
 * configured credential, are reached only under explicit paid-fallback policy.
 */

import { isPromoActive } from "./promo.js";
import type { ProviderBillingClass, PromoInfo } from "./types.js";

export interface BillingProfileLike {
  readonly billing?: ProviderBillingClass;
  readonly freeOnlyEligible?: boolean;
  readonly promo?: PromoInfo | undefined;
}

/** Effective billing class for a profile, promo-adjusted (an expired free promo becomes paid). */
export function effectiveBillingClass(profile: BillingProfileLike, now: number = Date.now()): ProviderBillingClass {
  const declared = profile.billing ?? "paid";
  if (declared === "free" && profile.promo && !isPromoActive(profile.promo, now)) return "paid";
  return declared;
}

/** Effective freeOnly eligibility for a profile. Defaults to `billing === "free"`. */
export function effectiveFreeOnlyEligible(profile: BillingProfileLike, now: number = Date.now()): boolean {
  return effectiveBillingClass(profile, now) === "free" && profile.freeOnlyEligible !== false;
}

/** Whether the profile may join the automatic free-only pool right now. */
export function isPoolFreeEligible(profile: BillingProfileLike, now: number = Date.now()): boolean {
  return effectiveFreeOnlyEligible(profile, now);
}

/**
 * Actionable reason a healthy candidate is blocked from the automatic pool
 * under free-only policy. Callers use it as the candidate's failure reason so
 * the pool summary explains WHY the provider was not tried.
 */
export function poolBlockedReason(billing: ProviderBillingClass, freeOnlyEligible: boolean): string {
  if (billing === "free") return "not eligible for the free pool (free tier not verified for this account)";
  if (billing === "trial") return "trial fallback not enabled";
  return "paid fallback not enabled";
}
