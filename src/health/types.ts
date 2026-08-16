/**
 * Health/recovery layer types.
 *
 * The health layer answers three questions without duplicating launcher or
 * provider logic:
 *   1. what is wrong (`HealthCheckResult`s from `checks.ts`),
 *   2. what can be done about it (`RepairAction`s from `repair.ts`),
 *   3. what just happened (`RepairOutcome`s, cooldowns, breaker state).
 *
 * Checks are read-only; repairs are explicit (only run under `doctor --repair`)
 * and bounded by cooldown + circuit-breaker state in `state.ts`.
 */

export type HealthStatus = "ok" | "degraded" | "down" | "skipped";

/** A named, self-contained health check. `detail` is always safe to print. */
export interface HealthCheckResult {
  readonly name: string;
  readonly status: HealthStatus;
  readonly detail: string;
  /** Repair strategy key when this check has an actionable recovery. */
  readonly repair?: RepairTarget;
  /** Extra data a repair needs (e.g. container name, pids). Never secrets. */
  readonly repairContext?: Record<string, string>;
}

export interface HealthReport {
  readonly overall: "healthy" | "degraded" | "down";
  readonly checks: readonly HealthCheckResult[];
  readonly ranAtMs: number;
}

/** What a repair is allowed to do. Declared here so recovery stays explicit. */
export type RepairTarget =
  | "docker-desktop"
  | "container-start"
  | "container-restart"
  | "container-recreate"
  | "provider-directive"
  | "credential-directive"
  | "stale-process-kill";

export type RepairOutcomeStatus = "repaired" | "skipped-cooldown" | "skipped-breaker" | "failed" | "aborted";

export interface RepairOutcome {
  readonly target: RepairTarget;
  readonly checkName: string;
  readonly status: RepairOutcomeStatus;
  readonly detail: string;
}

/** Injectable clock + shell so every recovery path is unit-testable. */
export interface HealthRuntime {
  readonly now: () => number;
  /** Run a shell command; resolves {code, stdout, stderr}. Never prints directly. */
  readonly run: (cmd: string, args: readonly string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** HTTP probe (used for gateway + functional auth-path health). GET by default;
   *  method/headers/body enable the non-secret POST probes that distinguish a
   *  degraded-but-"healthy" proxy from a genuinely working auth path. */
  readonly fetch: (
    url: string,
    init?: { timeoutMs?: number; method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; body?: string }>;
  /** Wait between recovery polls. Injected so waits are instant in tests. */
  readonly sleep: (ms: number) => Promise<void>;
}

export interface HealthOptions {
  /** Canonical Tencent Mac scripts dir (defaults to the Phase 13.1 canonical repo). */
  readonly tencentMacDir: string;
  /** MemoryCore gateway base URL, or undefined when not configured. */
  readonly memoryCoreUrl?: string;
  /** True when the user has explicitly configured the optional Tencent memory stack (CONTINUUM_MEMORY_CORE_URL set). */
  readonly tencentConfigured?: boolean;
  /** MemoryProxy health URL. */
  readonly proxyHealthUrl: string;
  /** Container names used by the canonical Mac stack. */
  readonly containers: { readonly memoryCore: string; readonly proxy: string; readonly hub: string };
  /** Pinned image the recovery path must preserve. */
  readonly pinnedImage: string;
  /** Where cooldown/breaker state is persisted. */
  readonly stateFile: string;
  /** Provider CLI executable names that a stale-process scan may reap (orphans only). */
  readonly providerExecutables: readonly string[];
}

/** Cooldown + circuit-breaker tuning. All overridable for tests. */
export interface RecoveryPolicy {
  readonly cooldownMs: number;
  readonly breakerFailureThreshold: number;
  readonly breakerOpenMs: number;
}
