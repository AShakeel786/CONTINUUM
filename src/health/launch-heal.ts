/**
 * Launch-time stack self-heal — the missing half of the recovery story.
 *
 * `continuum doctor --repair` already restores the Tencent/MemoryCore stack
 * in a bounded cascade (docker-desktop → containers → gateways). But a normal
 * desktop/session launch only ever *diagnosed* that stack (read-only
 * preflight) and then *degraded* — MemoryCore unreachable, proxy auth
 * unavailable, "local session context only" — without once invoking the
 * repair engine. Manually starting Docker didn't help either: the containers
 * were still down and nothing on the launch path started them.
 *
 * This module closes that gap. Before an agent that can use Tencent memory is
 * launched, it:
 *   1. runs the same read-only `HealthDoctor.diagnose()` the preflight used;
 *   2. if the user opted into the Tencent stack AND a recoverable check is
 *      down/degraded, takes a cross-process lock and runs the EXISTING
 *      `HealthDoctor.repair()` cascade (no duplicated Docker/container logic);
 *   3. re-evaluates from the POST-repair report — never the frozen pre-repair
 *      state — and returns either no warnings (recovered / already healthy) or
 *      a single concise, actionable degraded-mode line.
 *
 * Fast + cheap when the stack is already healthy: one diagnose pass, no lock,
 * no shelling out. Bounded when it isn't: the repair engine's own cooldown +
 * circuit breaker still apply, and concurrent launches share one repair via
 * the lock instead of racing several.
 */
import { dirname, join } from "node:path";
import type { HealthOptions, HealthReport, HealthRuntime, RecoveryPolicy } from "./types.js";
import { HealthDoctor } from "./doctor.js";
import { buildPreflightWarnings } from "./preflight.js";
import { FileRepairLock, type RepairLock } from "./repair-lock.js";

export interface LaunchHealDeps {
  readonly runtime: HealthRuntime;
  readonly options: HealthOptions;
  readonly policy: RecoveryPolicy;
  /**
   * True when the user has opted into the optional Tencent memory stack
   * (gateway endpoint + service token both resolved). Recovery only ever runs
   * for an opted-in stack; an unconfigured machine keeps the old warn-only
   * behavior.
   */
  readonly memoryConfigured: boolean;
  /** Stale-process probe (same one `runLaunchPreflight` passed). Optional. */
  readonly staleProcesses?: () => Promise<readonly { pid: number; executable: string }[]>;
  /** Cross-process repair lock; defaults to a file lock beside the health-state file. */
  readonly lock?: RepairLock;
  /** How long to wait for a concurrent launch's repair before giving up and using its result. */
  readonly lockWaitMs?: number;
  /** Short, stateful progress lines (never a raw retry-spam stream). */
  readonly onProgress?: (line: string) => void;
  /** Injectable Docker Desktop path discovery; default reads the live machine. */
  readonly discoverDockerDesktop?: () => Promise<string | undefined>;
}

export interface LaunchHealResult {
  /** Warning lines to surface (⚠️). Empty when healthy or fully recovered. */
  readonly warnings: readonly string[];
  /** True once `HealthDoctor.repair()` ran for this launch (ours, or one we waited on). */
  readonly repairAttempted: boolean;
  /** True when a repair ran and the stack ended up healthy. */
  readonly recovered: boolean;
}

const DEFAULT_LOCK_WAIT_MS = 5 * 60_000;

/** A check that is not-ok AND has an automatic recovery strategy. */
function isRecoverable(check: HealthReport["checks"][number]): boolean {
  return (check.status === "down" || check.status === "degraded") && !!check.repair;
}

function buildDoctor(deps: LaunchHealDeps): HealthDoctor {
  return new HealthDoctor({
    runtime: deps.runtime,
    options: deps.options,
    policy: deps.policy,
    ...(deps.staleProcesses ? { probes: { staleProcesses: deps.staleProcesses } } : {}),
    discoverDockerDesktop: deps.discoverDockerDesktop,
  });
}

async function safeDiagnose(doctor: HealthDoctor, fallback: HealthReport): Promise<HealthReport> {
  try {
    return await doctor.diagnose();
  } catch {
    return fallback;
  }
}

function finalize(report: HealthReport, deps: LaunchHealDeps): LaunchHealResult {
  if (report.overall === "healthy") {
    deps.onProgress?.("Tencent memory stack recovered — launching with full memory.");
    return { warnings: [], repairAttempted: true, recovered: true };
  }
  // Still degraded after recovery — ONE concise, actionable line (not the full
  // multi-line preflight dump, which would read as stale noise here).
  const unhealthy = report.checks
    .filter((c) => c.status === "down" || c.status === "degraded")
    .map((c) => c.name);
  const summary = unhealthy.length > 0 ? unhealthy.join(", ") : "stack unhealthy";
  return {
    warnings: [
      `Tencent memory auto-recovery incomplete (${summary}) — launching with local session context only. Run \`continuum doctor --repair\` for details.`,
    ],
    repairAttempted: true,
    recovered: false,
  };
}

/**
 * Diagnose → (bounded, locked) repair → re-evaluate. Never throws: any
 * failure degrades to "no warnings / not recovered" so a broken self-heal
 * can't block a launch.
 */
export async function ensureLaunchStackHealthy(deps: LaunchHealDeps): Promise<LaunchHealResult> {
  const doctor = buildDoctor(deps);

  let report: HealthReport;
  try {
    report = await doctor.diagnose();
  } catch {
    return { warnings: [], repairAttempted: false, recovered: false };
  }

  // Nothing to do the expensive way: already healthy, the user never opted
  // into the Tencent stack, or every failed check is a manual directive with
  // no automatic recovery. Behave exactly like the old warn-only preflight.
  if (!deps.memoryConfigured || !report.checks.some(isRecoverable)) {
    return { warnings: buildPreflightWarnings(report), repairAttempted: false, recovered: false };
  }

  const lock =
    deps.lock ??
    new FileRepairLock(join(dirname(deps.options.stateFile), "health-repair.lock"), deps.runtime.now);
  const handle = await lock.acquire(deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);

  if (!handle.acquired) {
    // A repair is taking longer than we're willing to wait. Use the current
    // (possibly already-improved) state; don't start a competing repair.
    return finalize(await safeDiagnose(doctor, report), deps);
  }

  try {
    // Re-check under the lock. A concurrent launch we just waited on may have
    // already fixed everything — or the user may have started Docker by hand
    // while we were waiting.
    const current = handle.waited ? await safeDiagnose(doctor, report) : report;
    if (!current.checks.some(isRecoverable)) {
      if (handle.waited) return finalize(current, deps);
      return { warnings: buildPreflightWarnings(current), repairAttempted: false, recovered: false };
    }

    deps.onProgress?.("Tencent memory stack degraded — attempting automatic recovery…");
    const { after } = await doctor.repair();
    return finalize(after, deps);
  } finally {
    await lock.release();
  }
}
