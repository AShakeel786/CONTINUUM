/**
 * TaskSession — durable, versioned operational state for one task. This is
 * explicitly NOT long-term knowledge (that's Tencent Memory, via Context
 * Manager) — it's "what is Agent A in the middle of, right now, on this
 * task" so Agent B can continue without re-auditing (Phase 5 brief) or
 * waiting on Tencent's async L0-L3 capture pipeline to catch up.
 *
 * Bounded lists (`recentToolActivity`) and explicit per-field update
 * methods (src/session/manager.ts) exist so state updates *during* work,
 * not only at session end — matching the brief's "State must update during
 * work, not only at session end."
 */

import type { ContextEnvelope } from "../context/types.js";
import type { SessionPricingState } from "../pricing/types.js";

export const SESSION_SCHEMA_VERSION = 1;

export type SessionStatus = "active" | "paused" | "handoff-pending" | "completed" | "abandoned";

/**
 * How this session is anchored:
 *  - "project"          → tied to a registered `ProjectRecord` (`projectId` set).
 *  - "general"           → no project, no fixed directory anchor (Tencent-style
 *    "no project" mode); `workingDirectory` is just where the launch happened.
 *  - "current-directory" → anchored to the launch cwd like a project (repo
 *    map/git fingerprint still apply), but never registered in ProjectRegistry.
 */
export type SessionMode = "project" | "general" | "current-directory";

export interface ProviderRef {
  readonly providerId: string;
  readonly model: string;
}

export interface ModelPreference {
  readonly model: string;
  readonly source: "user" | "project";
}

export interface WorkItem {
  readonly id: string;
  readonly description: string;
  readonly recordedAt: string;
}

export interface DecisionRecord {
  readonly id: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly recordedAt: string;
}

export interface FileRef {
  readonly path: string;
  readonly note?: string;
  readonly recordedAt: string;
}

export interface ToolActivityRecord {
  readonly id: string;
  readonly tool: string;
  readonly summary: string;
  readonly recordedAt: string;
}

/**
 * Read-only project-safety fingerprint. Modeled directly on
 * `windows/Add-TencentProject.ps1`'s `Get-ProjectFingerprint`/
 * `Compare-ProjectFingerprint` pattern (git remote/HEAD/file-count,
 * verified-good pre-existing design per TENCENT_MIGRATION_MAP.md) — with
 * `dirty`/`changedFileSummary` added, since the brief asks for them and the
 * PowerShell original predates any need to detect uncommitted work
 * specifically. Captured via read-only git commands only; nothing in this
 * module ever runs a mutating git command.
 */
export interface GitFingerprint {
  readonly repoRoot: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly headSha?: string;
  readonly dirty: boolean;
  /** Short human-readable summary, e.g. "3 modified, 1 untracked" — not a full diff. */
  readonly changedFileSummary: string;
  readonly capturedAt: string;
}

export interface CacheMetadataSnapshot {
  readonly stablePrefixHash?: string;
  readonly checkedAt?: string;
}

export interface HandoffMetadata {
  readonly handoffId: string;
  readonly fromProvider: ProviderRef;
  readonly toProvider: ProviderRef;
  readonly at: string;
}

export interface RolloverRecord {
  readonly rolloverId: string;
  readonly at: string;
  readonly providerId: string;
  readonly fromNativeSessionId: string;
  readonly toNativeSessionId: string;
  readonly handoffFile: string;
  readonly reason: string;
  readonly estimatedCostAvoidedUsd: number;
}

export interface TaskSession {
  readonly schemaVersion: number;
  readonly sessionId: string;
  /**
   * Monotonically increasing per-write counter — the optimistic-concurrency
   * token. A caller holding a stale `revision` cannot silently clobber a
   * newer write (src/session/errors.ts's `SessionConflictError`).
   */
  readonly revision: number;

  /** Set only for `mode === "project"` — absent for general/current-directory sessions. */
  readonly projectId?: string;
  readonly mode: SessionMode;
  readonly workingDirectory: string;
  readonly activeProvider: ProviderRef;
  /** Explicit model choice only; absent means provider default (Flash for DeepSeek). */
  readonly modelPreference?: ModelPreference;
  readonly taskGoal: string;
  readonly status: SessionStatus;

  readonly completedWork: readonly WorkItem[];
  readonly remainingWork: readonly WorkItem[];
  readonly importantDecisions: readonly DecisionRecord[];
  readonly relevantFiles: readonly FileRef[];
  /** Bounded ring buffer — see manager.ts's MAX_TOOL_ACTIVITY. */
  readonly recentToolActivity: readonly ToolActivityRecord[];

  readonly contextEnvelope?: ContextEnvelope;
  readonly cacheMetadata?: CacheMetadataSnapshot;
  readonly git?: GitFingerprint;
  /** Peak/off-peak cost-window state for `activeProvider`, when that provider has a pricing schedule. See src/pricing/. */
  readonly pricingAwareness?: SessionPricingState;

  readonly createdAt: string;
  readonly updatedAt: string;

  readonly lastHandoff?: HandoffMetadata;

  /**
   * Provider-native session ids, keyed by providerId. Written after a
   * successful launch (best-effort capture) and read on same-provider resume
   * to continue the provider's own CLI session instead of only injecting a
   * resume brief. Absent key = no known native session → fresh native session
   * + brief fallback. Never a fabricated id.
   */
  readonly nativeSessionIds?: Readonly<Record<string, string>>;
  /** Bounded audit trail; logical session/project identity remains unchanged. */
  readonly rollovers?: readonly RolloverRecord[];
}

export interface CreateSessionInput {
  readonly sessionId: string;
  /** Set only for `mode === "project"` (or omitted `mode`, which defaults to "project"). */
  readonly projectId?: string;
  /** Defaults to "project" when omitted, for backward compatibility with existing callers. */
  readonly mode?: SessionMode;
  readonly workingDirectory: string;
  readonly activeProvider: ProviderRef;
  readonly modelPreference?: ModelPreference;
  readonly taskGoal: string;
  readonly git?: GitFingerprint;
}
