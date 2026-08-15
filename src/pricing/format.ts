/**
 * Display formatting only — no scheduling math lives here (that's
 * calculator.ts, which never touches local time). "Keep all scheduling
 * calculations timezone-safe using UTC internally and display local time
 * where appropriate": this module is the "where appropriate" half.
 */

export function formatUtcClock(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/**
 * `timeZone` is an IANA zone name (e.g. "America/New_York"). Omit to use
 * the host's local zone — matches what a human operator actually sees on
 * their own machine.
 */
export function formatLocalClock(date: Date, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  return formatter.format(date);
}

export function formatRelativeDuration(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${minutes}m`;
}

export function describeTransition(
  transition: { readonly at: Date; readonly toTier: string },
  now: Date,
  timeZone?: string,
): string {
  const inMs = transition.at.getTime() - now.getTime();
  const relative = inMs > 0 ? `in ${formatRelativeDuration(inMs)}` : "just now";
  return `${transition.toTier} at ${formatUtcClock(transition.at)} (${formatLocalClock(transition.at, timeZone)} local), ${relative}`;
}
