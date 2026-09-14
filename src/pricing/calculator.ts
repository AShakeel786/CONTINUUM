/**
 * Generic peak/off-peak calculator. Nothing here knows about DeepSeek or
 * any other provider by name — it only interprets a `ProviderPricingSchedule`
 * (data). All arithmetic is done in UTC milliseconds-since-epoch (`Date`'s
 * native representation is timezone-agnostic; the only place "UTC" matters
 * is *interpreting* the schedule's "HH:MM" strings, done via `getUTCHours`/
 * `getUTCMinutes`, never local-time getters) — the brief's "keep all
 * scheduling calculations timezone-safe using UTC internally."
 */

import type { PricingTier, PricingTransition, PricingWindow, ProviderPricingSchedule } from "./types.js";

const MINUTES_PER_DAY = 24 * 60;

function parseHHMM(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid HH:MM time "${value}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid HH:MM time "${value}"`);
  return hours * 60 + minutes;
}

/** Minutes since UTC midnight, including fractional minutes from seconds/ms, for exact boundary comparisons. */
function utcMinuteOfDay(date: Date): number {
  return (
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000
  );
}

/** True if `minuteOfDay` falls within [start, end) of a window, handling midnight-crossing windows (end < start). */
function windowContains(window: PricingWindow, minuteOfDay: number): boolean {
  const start = parseHHMM(window.startUTC);
  const end = parseHHMM(window.endUTC);
  if (start === end) return false; // zero-width window matches nothing
  if (start < end) {
    return minuteOfDay >= start && minuteOfDay < end;
  }
  // Crosses midnight: e.g. 22:00-02:00 covers [22:00,24:00) U [00:00,02:00).
  return minuteOfDay >= start || minuteOfDay < end;
}

/** True if the schedule's peak windows apply on `date`'s UTC weekday. */
function isPeakDay(schedule: ProviderPricingSchedule, date: Date): boolean {
  const days = schedule.peakDaysUTC;
  if (days === undefined) return true; // daily-repeating schedule (backward compatible)
  return days.includes(date.getUTCDay());
}

export function getCurrentTier(schedule: ProviderPricingSchedule, now: Date): PricingTier {
  if (!isPeakDay(schedule, now)) return "off-peak";
  const minuteOfDay = utcMinuteOfDay(now);
  const isPeak = schedule.peakWindows.some((w) => windowContains(w, minuteOfDay));
  return isPeak ? "peak" : "off-peak";
}

/** Constructs a concrete UTC Date for "HH:MM" on the UTC calendar day that is `dayOffset` days after `referenceDate`'s UTC day. */
function boundaryDateOnDay(hhmm: string, referenceDate: Date, dayOffset: number): Date {
  const minute = parseHHMM(hhmm);
  const base = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()),
  );
  base.setUTCDate(base.getUTCDate() + dayOffset);
  base.setUTCMinutes(base.getUTCMinutes() + minute);
  return base;
}

/**
 * The next instant the tier changes, strictly after `now`. Robust to
 * overlapping/adjacent windows: rather than assuming a window's "start"
 * boundary always means "becomes peak," it re-derives the actual tier at
 * each candidate instant via `getCurrentTier`, so adjacent or overlapping
 * windows resolve correctly without special-case logic.
 *
 * Returns `undefined` only if the schedule has no peak windows at all
 * (permanently off-peak — there is no transition to report).
 */
export function getNextTransition(schedule: ProviderPricingSchedule, now: Date): PricingTransition | undefined {
  if (schedule.peakWindows.length === 0) return undefined;

  const candidates: Date[] = [];
  // 10 days of boundaries comfortably covers any window on a weekday-gated
  // schedule (the widest gap is a whole weekend: Friday 10:00 UTC →
  // Monday 01:00 UTC, up to ~3 days); cheap to compute regardless.
  for (let dayOffset = -1; dayOffset <= 9; dayOffset++) {
    for (const w of schedule.peakWindows) {
      candidates.push(boundaryDateOnDay(w.startUTC, now, dayOffset));
      candidates.push(boundaryDateOnDay(w.endUTC, now, dayOffset));
    }
  }

  const future = candidates
    .filter((d) => d.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  // Walk forward comparing each candidate's actual tier to the tier just
  // before it, rather than assuming every window boundary is a real
  // change -- correctly skips a boundary that turns out to be a no-op
  // (e.g. two windows adjacent or overlapping at that exact instant).
  let previousTier = getCurrentTier(schedule, now);
  let previousInstant = now.getTime();
  for (const candidate of future) {
    if (candidate.getTime() === previousInstant) continue; // duplicate boundary instant
    const tierHere = getCurrentTier(schedule, candidate);
    if (tierHere !== previousTier) {
      return { at: candidate, toTier: tierHere };
    }
    previousTier = tierHere;
    previousInstant = candidate.getTime();
  }
  return undefined; // unreachable in practice given the 3-day window, but never guess
}

/**
 * Like `getNextTransition`, but if `now` itself falls exactly on a
 * transition instant (tier at `now` differs from tier one millisecond
 * before it), returns *that* transition instead of skipping ahead to the
 * following one. `getNextTransition` is deliberately strictly-future
 * (correct for "what's coming up" diagnostics); this variant exists
 * specifically for the notification layer (`notifications.ts`), where a
 * check landing exactly on a transition must still be able to fire the
 * "it just started" notification rather than silently reporting the
 * *next* transition as if this one hadn't happened.
 */
export function getTransitionAtOrAfter(schedule: ProviderPricingSchedule, now: Date): PricingTransition | undefined {
  const justBefore = new Date(now.getTime() - 1);
  const tierJustBefore = getCurrentTier(schedule, justBefore);
  const tierNow = getCurrentTier(schedule, now);
  if (tierNow !== tierJustBefore) {
    return { at: new Date(now.getTime()), toTier: tierNow };
  }
  return getNextTransition(schedule, now);
}

export const __internal = { parseHHMM, utcMinuteOfDay, windowContains, MINUTES_PER_DAY };
