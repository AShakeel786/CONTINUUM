/**
 * Native-Claude context-assembly harness.
 *
 * Phase 1 (RUNTIME_FLOW.md §A, RISKS_AND_TECH_DEBT.md R-17) found that of
 * the launcher's three agent paths, only DeepSeek-via-proxy gets any memory
 * injection, project/task binding, or L0 capture — native Claude and native
 * Codex sessions are "memory-blind." This module proves the Context
 * Manager built this phase CAN close that gap for native Claude: the same
 * `buildContextEnvelope` → `allocateBudget` → `renderContextForProvider`
 * pipeline every other path uses, fed real MemoryCore recall, producing a
 * ready-to-send Anthropic system-block array + user-prefix string.
 *
 * Deliberately NOT wired into `windows/launch-tencent-claude.ps1` — that
 * would cross the Phase 4 hard boundary ("production launcher rewrite").
 * This is the tested harness the brief calls for instead: "A tested
 * integration/harness is sufficient if wiring the production launcher
 * would cross the launcher-redesign boundary."
 */

import { buildContextEnvelope } from "../context/envelope.js";
import { fetchDynamicRecallFromMemoryCore, fetchStableFromMemoryCore } from "../context/memorycore-client.js";
import type { MemoryCoreGatewayConfig } from "../context/memorycore-client.js";
import type { ContextEnvelope } from "../context/types.js";
import { allocateBudget } from "../token/budget.js";
import type { TokenBudgetResult } from "../token/types.js";
import { createProviderAdapter } from "../providers/adapter.js";
import { claudeProfile } from "../providers/profiles/claude.js";
import { renderContextForProvider } from "../rendering/render.js";
import type { RenderedContext } from "../rendering/types.js";

const DEFAULT_OUTPUT_RESERVE = 8192;

export interface NativeClaudeContextRequest {
  readonly sessionKey: string;
  readonly query: string;
  readonly memoryCore: MemoryCoreGatewayConfig;
  /** Tokens to reserve for Claude's own response. Defaults to 8192. */
  readonly outputTokenReserve?: number;
}

export interface NativeClaudeAssembledContext {
  readonly envelope: ContextEnvelope;
  readonly budget: TokenBudgetResult;
  readonly rendered: RenderedContext;
}

/**
 * Fetches real Tencent Memory (via the MemoryCore Gateway, read-only),
 * assembles it into a ContextEnvelope, budgets it against Claude's context
 * window, and renders it into Anthropic's wire shape — everything a native
 * Claude session would need to receive the same memory injection the
 * DeepSeek/proxy path already gets, without a proxy in the loop at all.
 */
export async function assembleNativeClaudeContext(
  req: NativeClaudeContextRequest,
): Promise<NativeClaudeAssembledContext> {
  const [stable, dynamic] = await Promise.all([
    fetchStableFromMemoryCore(req.memoryCore),
    fetchDynamicRecallFromMemoryCore(req.memoryCore, req.query),
  ]);

  const envelope = buildContextEnvelope({
    sessionKey: req.sessionKey,
    query: req.query,
    memoryCore: { stable, dynamic },
    extra: {
      teamId: req.memoryCore.teamId,
      agentId: req.memoryCore.agentId,
    },
  });

  const claudeAdapter = createProviderAdapter(claudeProfile);
  const contextWindow = claudeAdapter.getCapabilities().contextWindowTokens ?? 200_000;
  const budget = allocateBudget(envelope, {
    contextWindow,
    reservedOutput: req.outputTokenReserve ?? DEFAULT_OUTPUT_RESERVE,
  });

  const rendered = renderContextForProvider(budget.envelope, claudeAdapter);

  return { envelope, budget, rendered };
}
