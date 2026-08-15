/**
 * Notification dedupe logic. Only the off-peak → peak transition produces
 * user-facing notifications ("pre-peak" and "peak-started") — matching the
 * brief's examples and explicit test bullets (nothing asks for an
 * "off-peak starting" notification). Detection of *both* transition
 * directions still happens in the calculator/service layer for
 * diagnostics; this module is specifically the notification-firing layer.
 *
 * `providerDisplayName` is a parameter, not a hardcoded string, so this
 * stays generic across any provider with a pricing schedule — no
 * DeepSeek-specific logic lives here, only DeepSeek-specific *data*
 * (schedules/deepseek.ts).
 */

import { getTransitionAtOrAfter } from "./calculator.js";
import { formatRelativeDuration } from "./format.js";
import type {
  NotificationConfig,
  PendingNotificationRecord,
  PricingNotificationEvent,
  ProviderPricingSchedule,
} from "./types.js";

export interface ComputeNotificationEventsInput {
  readonly schedule: ProviderPricingSchedule;
  readonly providerDisplayName: string;
  readonly now: Date;
  readonly config: NotificationConfig;
  /** The dedup record from the last check (e.g. loaded from session state). Undefined on the first-ever check. */
  readonly priorRecord?: PendingNotificationRecord;
}

export interface ComputeNotificationEventsResult {
  readonly events: readonly PricingNotificationEvent[];
  /** Undefined only when the schedule has no peak windows at all (nothing to ever track). */
  readonly updatedRecord?: PendingNotificationRecord;
}

export function computeNotificationEvents(input: ComputeNotificationEventsInput): ComputeNotificationEventsResult {
  const { schedule, providerDisplayName, now, config, priorRecord } = input;
  const nextTransition = getTransitionAtOrAfter(schedule, now);
  if (!nextTransition) return { events: [], updatedRecord: undefined };

  const transitionAtIso = nextTransition.at.toISOString();

  // Roll over to a fresh record whenever the "next" transition has moved on
  // to a different instant than what was last tracked -- this is what lets
  // the daily-repeating schedule notify again on the *next* cycle instead
  // of being permanently marked "already notified."
  let record: PendingNotificationRecord =
    priorRecord && priorRecord.transitionAt === transitionAtIso
      ? priorRecord
      : { transitionAt: transitionAtIso, toTier: nextTransition.toTier, preNotified: false, startNotified: false };

  const events: PricingNotificationEvent[] = [];

  if (nextTransition.toTier === "peak") {
    const msUntil = nextTransition.at.getTime() - now.getTime();
    const minutesUntil = msUntil / 60_000;

    if (!record.preNotified && minutesUntil > 0 && minutesUntil <= config.leadTimeMinutes) {
      events.push({
        kind: "pre-peak",
        providerId: schedule.providerId,
        transitionAt: transitionAtIso,
        toTier: "peak",
        minutesUntil: Math.round(minutesUntil),
        message:
          `${providerDisplayName} peak pricing starts in ${formatRelativeDuration(msUntil)}. ` +
          `Continue with ${providerDisplayName} or hand off to another provider?`,
      });
      record = { ...record, preNotified: true };
    }

    if (!record.startNotified && minutesUntil <= 0) {
      events.push({
        kind: "peak-started",
        providerId: schedule.providerId,
        transitionAt: transitionAtIso,
        toTier: "peak",
        message: `${providerDisplayName} is now in peak pricing. Current session can continue, or you can hand it off to another available provider.`,
      });
      record = { ...record, startNotified: true };
    }
  }

  return { events, updatedRecord: record };
}
