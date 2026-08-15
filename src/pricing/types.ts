/**
 * Provider cost-window (peak/off-peak pricing) awareness.
 *
 * Deliberately data-first, same pattern as `src/providers/profiles/`: a
 * provider's schedule is plain, serializable config (`ProviderPricingSchedule`)
 * that the calculator (`calculator.ts`) interprets generically — nothing in
 * that engine mentions "DeepSeek" by name. Updating a provider's real-world
 * pricing windows later means editing `schedules/deepseek.ts`'s data, not
 * touching runtime logic (the brief's explicit "do not hardcode this
 * permanently as business logic").
 */

export type PricingTier = "peak" | "off-peak";

/**
 * A recurring daily UTC window, "HH:MM" 24-hour format, half-open
 * [start, end) — a session starting exactly at `startUTC` is peak; one
 * starting exactly at `endUTC` is not. Supports windows that cross
 * midnight (`endUTC < startUTC`, e.g. "22:00"–"02:00") for generality, even
 * though DeepSeek's current windows don't need it.
 */
export interface PricingWindow {
  readonly startUTC: string;
  readonly endUTC: string;
}

export interface ProviderPricingSchedule {
  readonly providerId: string;
  /** All times in this schedule are UTC — the brief's "keep all scheduling calculations timezone-safe using UTC internally." */
  readonly peakWindows: readonly PricingWindow[];
  /** Free-form note on where this schedule came from / when it was last checked against the provider's real published pricing — not consumed by any logic, just kept honest and traceable. */
  readonly source?: string;
}

export interface PricingTransition {
  readonly at: Date;
  readonly toTier: PricingTier;
}

export interface NotificationConfig {
  /** Minutes before a peak transition to fire the "starting soon" notification. Default 15. */
  readonly leadTimeMinutes: number;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = { leadTimeMinutes: 15 };

export type PricingNotificationKind = "pre-peak" | "peak-started";

export interface PricingNotificationEvent {
  readonly kind: PricingNotificationKind;
  readonly providerId: string;
  readonly transitionAt: string;
  readonly toTier: PricingTier;
  readonly minutesUntil?: number;
  readonly message: string;
}

/**
 * Dedup record for the *single* upcoming/current transition — reset once a
 * new transition becomes "next" (see notifications.ts). Persisting this in
 * session state (not just in memory) is what makes "no duplicate
 * notification after restart" possible.
 */
export interface PendingNotificationRecord {
  readonly transitionAt: string;
  readonly toTier: PricingTier;
  readonly preNotified: boolean;
  readonly startNotified: boolean;
}

/** Persisted on TaskSession — see session/types.ts's `pricingAwareness` field. */
export interface SessionPricingState {
  readonly providerId: string;
  readonly currentTier: PricingTier;
  readonly lastCheckedAt: string;
  readonly nextTransition?: { readonly at: string; readonly toTier: PricingTier };
  readonly pendingNotification?: PendingNotificationRecord;
}
