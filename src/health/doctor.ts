/**
 * `continuum doctor` — health report + explicit, bounded recovery.
 *
 * Orchestrates `checks.ts` + `repair.ts` behind one small API:
 *   - `diagnose()`  → read-only `HealthReport` (never mutates anything)
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
}

export interface RepairSummary {
  readonly outcomes: readonly RepairOutcome[];
  readonly after: HealthReport;
}

export class HealthDoctor {
  constructor(private readonly deps: HealthDoctorDeps) {}

  private state(): RecoveryState {
    return new RecoveryState(this.deps.options.stateFile, this.deps.policy, this.deps.runtime.now);
  }

  async diagnose(): Promise<HealthReport> {
    const checks = await runHealthChecks({
      runtime: this.deps.runtime,
      options: this.deps.options,
      providerStatus: this.deps.probes?.providerStatus,
      credentialStatus: this.deps.probes?.credentialStatus,
      sessionStatus: this.deps.probes?.sessionStatus,
      staleProcesses: this.deps.probes?.staleProcesses,
    });
    return { overall: overallOf(checks), checks, ranAtMs: this.deps.runtime.now() };
  }

  async repair(): Promise<RepairSummary> {
    const before = await this.diagnose();
    const state = this.state();
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
