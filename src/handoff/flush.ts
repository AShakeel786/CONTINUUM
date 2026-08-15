/**
 * Synchronous handoff flush (Phase 5 brief §3): captures the *current* task
 * state and produces a coherent handoff package immediately — "synchronous"
 * means "does not wait on Tencent's async L0-L3 extraction pipeline to
 * catch up," not "literally blocking JS." A best-effort, short-timeout
 * MemoryCore fetch is attempted; on any failure or timeout, the flush falls
 * back to the session's last stored `ContextEnvelope` snapshot rather than
 * failing — a handoff must never depend on eventual Tencent memory capture
 * (brief §8).
 */

import { randomUUID } from "node:crypto";
import { orderBlocks } from "../context/ordering.js";
import { fetchDynamicRecallFromMemoryCore, fetchStableFromMemoryCore } from "../context/memorycore-client.js";
import type { MemoryCoreGatewayConfig } from "../context/memorycore-client.js";
import { mapPersonaBlock, mapRecalledMemoryBlocks, mapSceneIndexBlock } from "../context/mapper.js";
import type { ContextBlock, ContextEnvelope } from "../context/types.js";
import { compareGitFingerprints } from "../session/git-fingerprint.js";
import type { GitFingerprint } from "../session/types.js";
import type { ProviderRef, TaskSession } from "../session/types.js";
import { allocateBudget } from "../token/budget.js";
import type { TokenLimits } from "../token/types.js";
import { buildResumeInstructionsBlock } from "./resume-block.js";
import { HANDOFF_SCHEMA_VERSION, type HandoffPackage } from "./types.js";

export interface FlushHandoffOptions {
  readonly sourceProvider: ProviderRef;
  readonly targetProvider: ProviderRef;
  readonly currentGit?: GitFingerprint;
  readonly tokenLimits: TokenLimits;
  readonly memoryCore?: {
    readonly config: MemoryCoreGatewayConfig;
    readonly query: string;
    /** Default 3000ms — deliberately short; a slow Gateway must never stall a handoff. */
    readonly timeoutMs?: number;
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface MemorySourcedBlocks {
  readonly stableBlocks: readonly ContextBlock[];
  readonly dynamicBlocks: readonly ContextBlock[];
  readonly recallStrategy?: string;
}

function assembleHandoffEnvelope(
  sessionKey: string,
  query: string,
  resumeBlock: ContextBlock,
  memorySourced: MemorySourcedBlocks | undefined,
): ContextEnvelope {
  const stableBlocks = orderBlocks([resumeBlock, ...(memorySourced?.stableBlocks ?? [])]);
  const dynamicBlocks = orderBlocks([...(memorySourced?.dynamicBlocks ?? [])]);
  return {
    stable: { blocks: stableBlocks },
    dynamic: { blocks: dynamicBlocks },
    metadata: {
      sessionKey,
      query,
      recallStrategy: memorySourced?.recallStrategy,
      assembledAt: new Date().toISOString(),
    },
  };
}

export async function flushHandoff(session: TaskSession, opts: FlushHandoffOptions): Promise<HandoffPackage> {
  const staleness =
    opts.currentGit && session.git
      ? compareGitFingerprints(session.git, opts.currentGit)
      : { stale: false, reasons: [] };

  const resumeBlock = buildResumeInstructionsBlock(session, staleness);

  let memorySourced: MemorySourcedBlocks | undefined;
  let freshness: HandoffPackage["tencentMemoryFreshness"] = "none";

  if (opts.memoryCore) {
    try {
      const timeoutMs = opts.memoryCore.timeoutMs ?? 3000;
      const [stable, dynamic] = await withTimeout(
        Promise.all([
          fetchStableFromMemoryCore(opts.memoryCore.config),
          fetchDynamicRecallFromMemoryCore(opts.memoryCore.config, opts.memoryCore.query),
        ]),
        timeoutMs,
      );
      memorySourced = {
        stableBlocks: [...mapPersonaBlock(stable), ...mapSceneIndexBlock(stable)],
        dynamicBlocks: mapRecalledMemoryBlocks(dynamic),
      };
      freshness = "fresh";
    } catch {
      // Fresh fetch unavailable/slow -- fall through to the stored snapshot.
      // A handoff must not fail or block because Tencent recall is delayed.
    }
  }

  if (!memorySourced && session.contextEnvelope) {
    memorySourced = {
      stableBlocks: session.contextEnvelope.stable.blocks,
      dynamicBlocks: session.contextEnvelope.dynamic.blocks,
      recallStrategy: session.contextEnvelope.metadata.recallStrategy,
    };
    freshness = "snapshot";
  }

  const envelope = assembleHandoffEnvelope(
    session.sessionId,
    opts.memoryCore?.query ?? session.taskGoal,
    resumeBlock,
    memorySourced,
  );

  const tokenBudget = allocateBudget(envelope, opts.tokenLimits);

  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId: randomUUID(),
    sessionId: session.sessionId,
    objective: session.taskGoal,
    completedWork: session.completedWork.map((w) => w.description),
    remainingWork: session.remainingWork.map((w) => w.description),
    decisions: session.importantDecisions.map((d) => (d.rationale ? `${d.decision} (${d.rationale})` : d.decision)),
    relevantFiles: session.relevantFiles.map((f) => (f.note ? `${f.path} — ${f.note}` : f.path)),
    gitSummary: session.git
      ? `branch=${session.git.branch ?? "?"}, HEAD=${(session.git.headSha ?? "?").slice(0, 12)}, status=${session.git.dirty ? session.git.changedFileSummary : "clean"}`
      : "(not captured)",
    recentToolActivity: session.recentToolActivity.map((a) => `[${a.tool}] ${a.summary}`),
    contextEnvelope: tokenBudget.envelope,
    tokenBudget,
    sourceProvider: opts.sourceProvider,
    targetProvider: opts.targetProvider,
    createdAt: new Date().toISOString(),
    staleness,
    tencentMemoryFreshness: freshness,
  };
}
