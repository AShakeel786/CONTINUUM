/**
 * Launcher orchestration types — the cross-platform `continuum` daily-
 * driving flow. This module wires existing systems (project registry,
 * session state, handoff, context, pricing, provider/auth) into a launch;
 * it owns no new storage or provider logic of its own.
 */

import type { ProjectRecord } from "../registry/types.js";
import type { ProviderRef, TaskSession } from "../session/types.js";

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
  /** Safe-by-default: true means the launch requires explicit opt-in bypass. */
  readonly bypassPermissions: boolean;
}

export interface ResolvedLaunchTarget {
  readonly project: ProjectRecord;
  readonly providerRef: ProviderRef;
  readonly session: TaskSession | undefined;
  readonly stale: boolean;
  readonly staleReasons: readonly string[];
}

export interface LaunchOptions {
  /** Explicit permission-bypass opt-in (safe-by-default: false disallows it). */
  readonly permissionMode: "safe" | "bypass";
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
}
