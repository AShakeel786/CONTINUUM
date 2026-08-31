/**
 * Local-dependency readiness gate for proxy-routed provider launches (the
 * Tencent MemoryProxy today — see `providers/profiles/deepseek.ts`).
 *
 * Root-cause context: a proxy-routed provider CLI (e.g. `claude` launched
 * with `ANTHROPIC_BASE_URL` redirected to the local proxy) has no visibility
 * into, or control over, CONTINUUM's own health/repair layer — if the proxy
 * is down, that CLI process just hits ECONNREFUSED against `127.0.0.1` and
 * retries on its own terms, producing a noisy, generic "connection
 * refused/firewall" loop that CONTINUUM cannot classify or stop. This module
 * is the fix: check + bounded self-heal the LOCAL dependency BEFORE handing
 * a doomed plan to that CLI, reusing the existing `HealthDoctor` (checks.ts +
 * repair.ts + the cooldown/circuit-breaker in state.ts) rather than building
 * a second recovery path.
 *
 * Fast path: a single proxy `/health` probe (a few ms when healthy). Only
 * escalates to the full `HealthDoctor.repair()` — which is itself bounded by
 * cooldown + circuit breaker, and never touches a container that isn't
 * actually reported unhealthy — when that probe fails.
 */
import type { HealthOptions, HealthRuntime, RecoveryPolicy } from "./types.js";
import { HealthDoctor } from "./doctor.js";

export interface ProxyReadiness {
  readonly ready: boolean;
  /** Safe-to-print, secret-free summary of what was found/done (built entirely from HealthCheckResult/RepairOutcome `detail` fields, which are documented as always-safe-to-print). */
  readonly detail: string;
  /** True once a repair attempt actually ran (a first probe alone doesn't count) — distinguishes "was already up" from "self-healed" for diagnostics. */
  readonly repairAttempted: boolean;
}

export interface EnsureProxyReadyDeps {
  readonly runtime: HealthRuntime;
  readonly options: HealthOptions;
  readonly policy: RecoveryPolicy;
  /** Injectable Docker Desktop path discovery; default reads the live machine. */
  readonly discoverDockerDesktop?: () => Promise<string | undefined>;
}

const FAST_PROBE_TIMEOUT_MS = 3000;

/**
 * Builds the readiness-check function `Launcher.prepareLaunch` calls right
 * before it would otherwise build a proxy-routed launch plan. `onProgress`
 * (optional) receives short, stateful UX lines as the check/repair
 * proceeds — never a raw retry-spam stream.
 */
export function makeEnsureProxyReady(
  deps: EnsureProxyReadyDeps,
): (proxyBaseUrl: string, onProgress?: (line: string) => void) => Promise<ProxyReadiness> {
  return async (proxyBaseUrl: string, onProgress?: (line: string) => void): Promise<ProxyReadiness> => {
    const startedAtMs = deps.runtime.now();
    const probe = await deps.runtime.fetch(deps.options.proxyHealthUrl, { timeoutMs: FAST_PROBE_TIMEOUT_MS });
    if (probe.ok) {
      return { ready: true, detail: `proxy healthy (${proxyBaseUrl})`, repairAttempted: false };
    }

    onProgress?.(`Proxy unavailable at ${hostOf(proxyBaseUrl)} — checking service…`);

    // Fast probe failed — escalate to the full, bounded self-heal path.
    // Deliberately omits `probes` (provider/credential/session callbacks):
    // this stays a LOCAL-dependency check only, never touching provider
    // auth or credential state, and never restarting a container the
    // checks below didn't themselves report as failed.
    const doctor = new HealthDoctor({
      runtime: deps.runtime,
      options: deps.options,
      policy: deps.policy,
      discoverDockerDesktop: deps.discoverDockerDesktop,
    });
    const { outcomes, after } = await doctor.repair();

    const repaired = outcomes.filter((o) => o.status === "repaired");
    if (repaired.length > 0) onProgress?.("Proxy restarted — waiting for readiness…");

    // Ground truth is a fresh direct probe, NOT `after.checks`'s
    // "gateway:proxy" status: that field means "skipped" (not "down") when
    // the Tencent stack was never deployed/configured at all — correct for
    // the general health *dashboard* (it's an optional feature there), but
    // wrong here — a proxy-routed launch needs the proxy regardless of
    // whether the user ever opted into the broader Tencent memory stack.
    // Trusting "skipped == fine" here would silently launch straight into
    // the exact ECONNREFUSED loop this gate exists to prevent.
    const recheck = await deps.runtime.fetch(deps.options.proxyHealthUrl, { timeoutMs: FAST_PROBE_TIMEOUT_MS });
    const repairSummary = outcomes.length > 0 ? outcomes.map((o) => `${o.checkName}: ${o.status} (${o.detail})`).join("; ") : "no automatic repair available for this failure";

    if (recheck.ok) {
      const elapsedS = ((deps.runtime.now() - startedAtMs) / 1000).toFixed(1);
      onProgress?.(`Recovered in ${elapsedS}s — resuming session.`);
      return { ready: true, detail: `proxy recovered (${repairSummary})`, repairAttempted: true };
    }

    const proxyCheck = after.checks.find((c) => c.name === "gateway:proxy" && c.status === "down");
    return {
      ready: false,
      detail: proxyCheck ? `${proxyCheck.detail} — ${repairSummary}` : `proxy still unreachable at ${proxyBaseUrl} — ${repairSummary}`,
      repairAttempted: true,
    };
  };
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}
