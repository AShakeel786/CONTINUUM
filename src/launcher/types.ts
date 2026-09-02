/**
 * Launcher orchestration types — the cross-platform `continuum` daily-
 * driving flow. This module wires existing systems (project registry,
 * session state, handoff, context, pricing, provider/auth) into a launch;
 * it owns no new storage or provider logic of its own.
 */

import type { ProjectRecord } from "../registry/types.js";
import type { ProviderRef, TaskSession } from "../session/types.js";
import type { RenderedContext } from "../rendering/types.js";
import type { LaunchRoute, ProviderAdapter, ProviderBillingClass } from "../providers/types.js";

/** A concrete plan for spawning a provider CLI. */
export interface LaunchPlan {
  readonly providerId: string;
  readonly model: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** Env vars to SET for the child (may hold resolved secrets). */
  readonly env: Readonly<Record<string, string>>;
  /** Env vars to clear from the inherited environment. */
  readonly clearEnvVars: readonly string[];
  readonly workingDir: string;
  readonly configDir?: string;
  /** True when the launch carries the provider's declared native full-access (bypass) flag. */
  readonly bypassPermissions: boolean;
  /**
   * When set, spawn tees the child's stderr to the terminal AND retains the
   * last N bytes in memory so an auto-routed launch can classify a runtime
   * provider failure and fall back (see launcher/cli-failure.ts). Absent →
   * stdio fully inherited, nothing captured — explicit-provider launches
   * never set this.
   */
  readonly stderrTailBytes?: number;
}

/** Which runtime carries a launch: the provider's native CLI, or CONTINUUM's generic API agent. */
export type LaunchRuntimeKind = "cli" | "api";

/** Secret-bearing only in-memory input for the composite API runner. */
export interface ApiFailoverLaunchCandidate {
  readonly adapter: ProviderAdapter;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly billing: ProviderBillingClass;
  readonly disabledReason?: string;
}

export interface ResolvedLaunchTarget {
  readonly project: ProjectRecord;
  readonly providerRef: ProviderRef;
  readonly session: TaskSession | undefined;
  readonly stale: boolean;
  readonly staleReasons: readonly string[];
}

export interface LaunchOptions {
  /**
   * Explicit launch permission mode. Absent → "bypass" (full access) for
   * every CLI-backed launch whose resolved descriptor declares a verified
   * native bypass flag; "safe" explicitly restores normal approval mode.
   * An explicit caller choice always wins.
   */
  readonly permissionMode?: "safe" | "bypass";
  /** Explicit permission for automatic routing to select a paid provider. */
  readonly allowPaidFallback?: boolean;
  /**
   * INTERNAL — set by `launchPrepared` when re-preparing a launch after an
   * automatic-routing fallback. Records which provider just failed so the
   * re-prepared `modelDecision.reason` reads `automatic-fallback: X → Y`
   * instead of an ordinary (and misleading) resume/provider-change reason.
   * Never set by callers.
   */
  readonly autoFallbackFrom?: string;
}

/** Result of computing a launch target without spawning anything — testable in isolation from process spawning. */
export interface LaunchPreparation {
  readonly plan: LaunchPlan;
  readonly project: ProjectRecord;
  readonly providerRef: ProviderRef;
  readonly session?: TaskSession;
  readonly stale: boolean;
  readonly staleReasons: readonly string[];
  readonly memoryCoreAvailable: boolean;
  /** Human-readable degradation note when MemoryCore is unavailable. */
  readonly memoryCoreNote?: string;
  /** Set when this launch resumes the provider's own native CLI session (by stored id). */
  readonly nativeResume?: { readonly providerId: string; readonly nativeSessionId: string };
  /** Which runtime carries this launch (CLI vs generic API agent). */
  readonly runtimeKind: LaunchRuntimeKind;
  /** The budgeted + provider-rendered context, for the API agent to send as its first turn. */
  readonly rendered: RenderedContext;
  /** The target provider's context-window ceiling used for this launch's Token Manager budget (src/token/budget.ts). */
  readonly contextWindowTokens: number;
  /** Tokens actually occupied by the rendered context after budgeting/trimming — the Token Manager's own `inputTokensAfter` count, not re-estimated. */
  readonly contextTokensUsed: number;
  /** The launch route actually resolved for this run (direct default; proxy only when explicitly configured) — see `LauncherDeps.getProviderRoute`. */
  readonly route: LaunchRoute;
  readonly modelDecision: { readonly automatic: boolean; readonly reason: string };
  /**
   * Present only when the AUTOMATIC provider-preference chain selected this
   * provider (no explicit provider/model/project selection). Carries the
   * chain and the selected index so `launchPrepared` can fall back to the
   * next usable chain member when the first choice fails at runtime.
   */
  readonly autoRoute?: { readonly chain: readonly string[]; readonly index: number };
  /**
   * Visible messaging when a requested/saved model was NOT in the installed
   * CLI's current model list and CONTINUUM fell back to the provider default
   * (never a silent ignore). Absent = no fallback happened.
   */
  readonly modelNote?: string;
  /**
   * Visible messaging when full-access ("bypass") was requested but the
   * provider declares no native bypass flag, so the launch ran in normal
   * approval mode. Absent = mode was honored (or never requested).
   */
  readonly permissionNote?: string;
  readonly rollover?: { readonly fromNativeSessionId: string; readonly toNativeSessionId: string; readonly handoffFile: string; readonly reason: string; readonly estimatedCostAvoidedUsd: number };
  /**
   * Stable project-memory scope key for this launch — the project registry
   * `id` for a project-mode session, `undefined` for general / current-
   * directory (whose non-project memory identity is intentional). The
   * in-process Direct-API tool registry (`launchPrepared`) passes this to
   * `buildToolRegistry` as `memoryProjectScope` so `memory_recall` /
   * `memory_search` / `memory_capture` from the API agent hit the same
   * per-project MemoryCore bucket the launcher's own context injection uses —
   * never the global `default` bucket.
   */
  readonly projectScope?: string;
}
