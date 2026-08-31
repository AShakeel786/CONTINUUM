/**
 * `continuum doctor` — health report + explicit, bounded recovery.
 *
 * Orchestrates `checks.ts` + `repair.ts` behind one small API:
 *   - `diagnose()`  → `HealthReport` (read-only against the stack; the ONLY
 *                     write is persisting that the Tencent containers were
 *                     observed, which lets a later stopped-engine launch know
 *                     to auto-start Docker Desktop)
 *   - `repair()`    → runs repairs ONLY for failed checks, gated by
 *                     cooldown/circuit-breaker, then re-diagnoses
 *
 * All side effects live in repair strategies; this class owns sequencing and
 * the final verdict. No secret values ever pass through report/outcome text.
 */
import type { HealthCheckResult, HealthOptions, HealthReport, HealthRuntime, RecoveryPolicy, RepairOutcome } from "./types.js";
import { overallOf, runHealthChecks, type CheckDeps } from "./checks.js";
import { runRepairs } from "./repair.js";
import { RecoveryState } from "./state.js";
import { defaultDockerDesktopDiscovery } from "./docker-desktop.js";

/** How many diagnose→repair→re-diagnose rounds a single `repair()` runs before giving up. */
const MAX_REPAIR_ROUNDS = 3;

export interface HealthDoctorDeps {
  readonly runtime: HealthRuntime;
  readonly options: HealthOptions;
  readonly policy: RecoveryPolicy;
  /** Provider/credential/session/process probes, same shape as CheckDeps. */
  readonly probes?: Omit<CheckDeps, "runtime" | "options">;
  /** Injectable pinned-env read (tests); default reads the canonical .env. */
  readonly readPinnedEnv?: () => Promise<string | undefined>;
  /** Injectable Docker Desktop path discovery; default reads the live machine. */
  readonly discoverDockerDesktop?: () => Promise<string | undefined>;
  /** One-line recovery progress (Docker boot stages); never a raw retry stream. */
  readonly onProgress?: (line: string) => void;
  /** Injectable engine-prerequisite probe; default runs `wsl --status` on Windows. */
  readonly probeEnginePrerequisite?: (runtime: HealthRuntime) => Promise<{ ok: boolean; detail: string }>;
}

export interface RepairSummary {
  readonly outcomes: readonly RepairOutcome[];
  readonly after: HealthReport;
}

export class HealthDoctor {
  /** Shared across diagnose/repair so the persisted marker and the cooldown/breaker state never clobber each other's writes to the same file. */
  private readonly state: RecoveryState;

  constructor(private readonly deps: HealthDoctorDeps) {
    this.state = new RecoveryState(deps.options.stateFile, deps.policy, deps.runtime.now);
  }

  async diagnose(): Promise<HealthReport> {
    await this.state.load();
    const seen = this.state.stackSeen();
    const options = {
      ...this.deps.options,
      ...(seen ? { stackSeen: true } : {}),
      // Same default the repair path uses (repair.ts): real machine discovery
      // unless the caller injected a fake. Lets the docker-desktop repair arm
      // on a stopped engine purely from Docker Desktop being installed.
      dockerDesktopDiscovery: this.deps.discoverDockerDesktop ?? defaultDockerDesktopDiscovery,
    };
    const checks = await runHealthChecks({
      runtime: this.deps.runtime,
      options,
      providerStatus: this.deps.probes?.providerStatus,
      credentialStatus: this.deps.probes?.credentialStatus,
      sessionStatus: this.deps.probes?.sessionStatus,
      staleProcesses: this.deps.probes?.staleProcesses,
    });
    await this.reconcileStackPresence(checks, seen);
    return { overall: overallOf(checks), checks, ranAtMs: this.deps.runtime.now() };
  }

  /**
   * Record whether the Tencent stack's containers are actually deployed, so a
   * later launch with a stopped engine still knows to start Docker Desktop.
   * Only runs when the engine is reachable (through a stopped engine the
   * containers are invisible and the last-known answer is kept). The only
   * write diagnose ever makes — and it is a presence record, never a stack
   * mutation, so the read-only contract otherwise holds.
   */
  private async reconcileStackPresence(checks: readonly HealthCheckResult[], previouslySeen: boolean): Promise<void> {
    const docker = checks.find((c) => c.name === "docker");
    if (!docker || docker.status !== "ok") return;
    const hasDeployedContainer = checks.some(
      (c) => c.name.startsWith("container:") && (c.status === "ok" || c.status === "degraded" || c.repair === "container-start"),
    );
    if (hasDeployedContainer === previouslySeen) return;
    if (hasDeployedContainer) this.state.markStackSeen();
    else this.state.clearStackSeen();
    try {
      await this.state.persist();
    } catch {
      // A presence-record write must never break a read-only diagnose.
    }
  }

  async repair(): Promise<RepairSummary> {
    const before = await this.diagnose();
    const state = this.state;
    await state.load();
    const outcomes: RepairOutcome[] = [];
    let checks = before.checks;
    // Cascade in rounds so one `--repair` pass restores the full stack: a
    // docker-desktop repair in round N makes containers visible to round N+1
    // (they were "skipped"/unreachable while the daemon was down), and a
    // container repair makes the gateway probes pass in the round after.
    // Each round is still bounded by the same per-target cooldown/breaker.
    for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
      const roundOutcomes = await runRepairs(
        {
          runtime: this.deps.runtime,
          options: this.deps.options,
          state,
          readPinnedEnv: this.deps.readPinnedEnv,
          discoverDockerDesktop: this.deps.discoverDockerDesktop,
          onProgress: this.deps.onProgress,
          probeEnginePrerequisite: this.deps.probeEnginePrerequisite,
        },
        checks,
      );
      outcomes.push(...roundOutcomes);
      // Re-diagnose so the caller sees post-repair reality, not the stale report.
      const after = await this.diagnose();
      if (after.overall === "healthy") return { outcomes, after };
      // Cascade only when this round actually repaired something. A round of
      // only failed/deferred/skipped/aborted outcomes is a dead end.
      if (!roundOutcomes.some((o) => o.status === "repaired")) return { outcomes, after };
      checks = after.checks;
    }
    const after = await this.diagnose();
    return { outcomes, after };
  }

  /** Convenience: report → human-readable lines (safe to print verbatim). */
  static formatReport(report: HealthReport): readonly string[] {
    const lines: string[] = [`overall: ${report.overall}`];
    for (const check of report.checks) {
      const icon = check.status === "ok" ? "ok" : check.status === "degraded" ? "~~" : check.status === "skipped" ? "--" : "!!";
      lines.push(`  ${icon} ${check.name}: ${check.detail}`);
    }
    return lines;
  }

  static formatOutcome(outcome: RepairOutcome): string {
    return `  [${outcome.status}] ${outcome.checkName} (${outcome.target}): ${outcome.detail}`;
  }
}
