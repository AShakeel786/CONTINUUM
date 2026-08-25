/**
 * Promotional-availability helpers — pure, deterministic, no I/O.
 *
 * A provider's `PromoInfo` describes a TEMPORARY promotional state (e.g.
 * "free preview"). Expiry is temporal only when an authoritative `until`
 * was declared by the upstream source — a promo without `until` is treated
 * as active "for a limited time" with an unknown end, so automatic routing
 * falls back to current provider usability (never a guessed date). Once a
 * declared `until` passes, the promo is no longer advertised or
 * auto-preferred, but the provider stays explicitly selectable — it is the
 * user's choice to keep using it when it stops being free.
 */

import type { PromoInfo } from "./types.js";

/** True while the promo has no declared end, or `now` is before its declared `until`. */
export function isPromoActive(promo: PromoInfo, now: number = Date.now()): boolean {
  if (promo.until === undefined) return true;
  const until = Date.parse(promo.until);
  return Number.isFinite(until) && now < until;
}

/**
 * Short human label for an ACTIVE promo:
 *   - with an authoritative `until` → `FREE (until Aug 27)`
 *   - without one (unknown end)   → `FREE · limited time`
 * Returns undefined once a declared `until` has passed.
 */
export function formatPromoLabel(promo: PromoInfo | undefined, now: number = Date.now()): string | undefined {
  if (!promo || !isPromoActive(promo, now)) return undefined;
  if (promo.until !== undefined) {
    const until = Date.parse(promo.until);
    if (!Number.isFinite(until)) return undefined;
    const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(until);
    return `${promo.note} (until ${date})`;
  }
  return `${promo.note} · limited time`;
}
