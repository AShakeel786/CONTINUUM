import type { ContextEnvelope } from "../context/types.js";
import type { FingerprintComparison } from "../session/git-fingerprint.js";
import type { ProviderRef } from "../session/types.js";
import type { TokenBudgetResult } from "../token/types.js";

export const HANDOFF_SCHEMA_VERSION = 1;

/**
 * A synchronously-flushed, token-budgeted package of everything a
 * receiving agent needs to continue the same task immediately — not a
 * conversation dump (brief: "Do not dump entire conversation history
 * blindly"). Rendered summaries only; the bounded lists come straight from
 * `TaskSession`'s own explicit-update fields, which is what keeps this
 * small enough to actually fit a token budget.
 */
export interface HandoffPackage {
  readonly schemaVersion: number;
  readonly handoffId: string;
  readonly sessionId: string;

  readonly objective: string;
  readonly completedWork: readonly string[];
  readonly remainingWork: readonly string[];
  readonly decisions: readonly string[];
  readonly relevantFiles: readonly string[];
  readonly gitSummary: string;
  readonly recentToolActivity: readonly string[];

  /**
   * The token-budgeted context actually handed to the receiving provider —
   * includes a synthesized "instructions"-class resume block (protected
   * from trimming by the Token Manager's own "instructions" exemption) plus
   * whatever Tencent Memory content was available (fresh, or the session's
   * last known snapshot — see `tencentMemoryFreshness`).
   */
  readonly contextEnvelope: ContextEnvelope;
  readonly tokenBudget: TokenBudgetResult;

  readonly sourceProvider: ProviderRef;
  readonly targetProvider: ProviderRef;
  readonly createdAt: string;

  readonly staleness: FingerprintComparison;

  /**
   * Whether the Tencent Memory content in `contextEnvelope` came from a
   * fresh MemoryCore fetch made during this flush, or from the session's
   * last stored snapshot (fetch skipped, timed out, or failed) — the
   * explicit signal behind "must still work when recent L0-L3 extraction is
   * delayed": a handoff never blocks or fails because of this, but the
   * receiving agent (and any caller) can tell which case happened.
   */
  readonly tencentMemoryFreshness: "fresh" | "snapshot" | "none";
}
