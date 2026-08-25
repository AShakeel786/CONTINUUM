/**
 * Generic CLI runtime-failure classifier — decides whether an auto-routed
 * CLI launch (e.g. a redirected coding-agent session) that exited nonzero
 * failed because of the PROVIDER/RUNTIME side (rate limit, upstream provider
 * capacity, network/service, auth) or the LOCAL side (user interrupt,
 * ordinary task failure, permission denial, malformed input).
 *
 * Input is a bounded tail of the child's sanitized stderr plus its exit code.
 * The classifier is deliberately provider-agnostic: it never keys on a
 * provider id, only on transport-level error vocabulary that any harness
 * prints for these failure classes. Its only consumer is the automatic
 * routing fallback in `launchPrepared` — explicit-provider launches never
 * consult it, so a misclassification can never silently switch a provider
 * the user explicitly chose.
 */

/** Coarse failure categories for a CLI launch's nonzero exit. */
export type CliFailureKind =
  | "rate-limit"
  | "upstream-provider"
  | "network-service"
  | "auth"
  | "local";

export interface CliFailureClassification {
  readonly kind: CliFailureKind;
  /**
   * True when automatic routing may retry on the next preference-chain
   * member. Mirrors the direct API-agent semantics, where ANY typed
   * ApiAgentError (rate-limit/network/server/auth) falls back and only
   * local failures don't. `local` is never eligible.
   */
  readonly fallbackEligible: boolean;
}

/**
 * Exit codes owned by the user or the OS, not the provider: 130 = SIGINT
 * (Ctrl+C), 143 = SIGTERM. A signal-killed child (`exitCode: null`) is
 * treated the same way — CONTINUUM cannot attribute it to the provider, so
 * it must not auto-switch.
 */
const USER_EXIT_CODES: ReadonlySet<number> = new Set([130, 143]);

const CANCEL_MARKERS: readonly RegExp[] = [
  /\binterrupted\b/i,
  /\baborted by user\b/i,
  /\b(?:canceled|cancelled) by user\b/i,
];

const AUTH_MARKERS: readonly RegExp[] = [
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\binvalid[ _-](?:api[ _-])?key\b/i,
  /\binvalid_api_key\b/i,
  /\bapi key (?:is )?(?:invalid|not valid|missing)\b/i,
  /\bauthentication[ _]?(?:error|failed|required)\b/i,
  /\bhttp(?: status)? 40[13]\b/i,
];

const RATE_LIMIT_MARKERS: readonly RegExp[] = [
  // "429" only counts as a status when an API-error line carries it or an
  // explicit rejection/rate vocabulary sits on the same line — a bare number
  // in ordinary output must never route a provider switch.
  /\bapi error\b[^\n]*\b429\b/i,
  /\b429\b[^\n]{0,80}(?:rate|limit|reject|throttl|too many|provider)/i,
  /\brate[- _]?limit\w*/i,
  /\bthrottl\w*/i,
  /\btoo many requests\b/i,
  /quota exceeded/i,
];

const UPSTREAM_MARKERS: readonly RegExp[] = [
  /provider returned error/i,
  // "upstream" only counts with adjacent error vocabulary — ordinary output
  // (git's "push to upstream branch") must never route a provider switch.
  /\bupstream\b[^\n]{0,40}\b(?:error|rate|limit|capacity|unavailable|reject|saturat)/i,
  /\b(?:error|rate-limited|saturated|at capacity)[^\n]{0,40}\bupstream\b/i,
  /\boverloaded\b/i,
  /\bat capacity\b/i,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\binternal server error\b/i,
  // A bare "API Error" line carrying a 5xx status — scoped to API-error
  // lines so ordinary output containing numbers can't false-positive.
  /\bapi error\b[^\n]*\b5\d\d\b/i,
];

const NETWORK_MARKERS: readonly RegExp[] = [
  /\beconn(?:reset|refused|aborted)\b/i,
  /\betimedout\b/i,
  /\benotfound\b/i,
  /\beai_again\b/i,
  /\bfetch failed\b/i,
  /\bsocket hang up\b/i,
  /\bnetwork (?:error|timeout|request failed)\b/i,
  /\btemporarily (?:unavailable|unreachable)\b/i,
];

function matchesAny(text: string, markers: readonly RegExp[]): boolean {
  return markers.some((m) => m.test(text));
}

/**
 * Classify one failed CLI launch. `stderrTail` is the captured tail of the
 * child's stderr (may be undefined when no capture was requested); empty or
 * unmatched output classifies as `local` — fallback requires positive
 * evidence of a provider/runtime-side failure.
 */
export function classifyCliFailure(exitCode: number | null, stderrTail: string | undefined): CliFailureClassification {
  const kind = classifyKind(exitCode, stderrTail ?? "");
  return { kind, fallbackEligible: kind !== "local" };
}

function classifyKind(exitCode: number | null, tail: string): CliFailureKind {
  if (exitCode === null || exitCode === 0 || USER_EXIT_CODES.has(exitCode)) return "local";
  const text = tail;
  if (matchesAny(text, CANCEL_MARKERS)) return "local";
  if (matchesAny(text, AUTH_MARKERS)) return "auth";
  if (matchesAny(text, RATE_LIMIT_MARKERS)) return "rate-limit";
  if (matchesAny(text, UPSTREAM_MARKERS)) return "upstream-provider";
  if (matchesAny(text, NETWORK_MARKERS)) return "network-service";
  return "local";
}
