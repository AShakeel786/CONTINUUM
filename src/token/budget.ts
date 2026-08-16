/**
 * Deterministic token budgeting. Consumes a ContextEnvelope (never builds
 * one — that's Context Manager's job) and a provider's context-window
 * limits, and returns a possibly-trimmed envelope plus a full report of
 * what was dropped/truncated and why (Phase 4 requirement: "expose
 * before/after token counts" and "identify what was dropped and why").
 *
 * Trimming order: the "instructions" class is never touched, full stop —
 * not "trimmed last", genuinely exempt (see `criticalContentOverBudget`).
 * Everything else is ranked by each block's own `priority` (lower = kept
 * longer, matching the field's doc comment in context/types.ts), with
 * `recalled-memory` blocks defaulting to the highest (most disposable)
 * priority — the same framing auto-recall.ts itself uses for L1 recall
 * ("仅作为参考", reference-only, explicitly not permanent instruction).
 */

import { addTokenCounts, estimateTokens } from "./tokenizer.js";
import { orderBlocks } from "../context/ordering.js";
import type { ContextBlock, ContextEnvelope } from "../context/types.js";
import type { TokenBudgetResult, TokenCount, TokenLimits, TrimEvent } from "./types.js";

const TRUNCATION_SUFFIX = "\n…[truncated by token budget]";

/**
 * Binary-search a code-point-safe prefix of `text` whose estimated token
 * count fits within `maxTokens`. Code-point (not UTF-16 code unit) slicing,
 * matching the same safety concern `auto-recall.ts`'s `truncateRecallLine`
 * documents (a cut must never land inside a surrogate pair).
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const suffixTokens = estimateTokens(TRUNCATION_SUFFIX).tokens;
  const budgetForBody = maxTokens - suffixTokens;
  if (budgetForBody <= 0) return "";

  const codePoints = Array.from(text);
  if (estimateTokens(text).tokens <= maxTokens) return text;

  let lo = 0;
  let hi = codePoints.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = codePoints.slice(0, mid).join("");
    if (estimateTokens(candidate).tokens <= budgetForBody) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const body = codePoints.slice(0, lo).join("").trimEnd();
  return body ? `${body}${TRUNCATION_SUFFIX}` : "";
}

export function allocateBudget(envelope: ContextEnvelope, limits: TokenLimits): TokenBudgetResult {
  const availableForInput = limits.contextWindow - limits.reservedOutput;
  const allBlocks = [...envelope.stable.blocks, ...envelope.dynamic.blocks];

  const tokenCounts = new Map<string, TokenCount>(allBlocks.map((b) => [b.id, estimateTokens(b.content)]));
  const totalBefore = allBlocks.reduce(
    (sum, b) => addTokenCounts(sum, tokenCounts.get(b.id)!),
    { tokens: 0, method: "tiktoken-estimate" } as TokenCount,
  );

  if (totalBefore.tokens <= availableForInput) {
    return {
      envelope,
      inputTokensBefore: totalBefore,
      inputTokensAfter: totalBefore,
      availableForInput,
      trimEvents: [],
      criticalContentOverBudget: false,
    };
  }

  // "instructions" (system constraints) and "current-task" (what the agent is
  // doing right now) are never pruned — everything else is a candidate.
  const PROTECTED = new Set(["instructions", "current-task"]);
  const protectedBlocks = allBlocks.filter((b) => PROTECTED.has(b.class));
  const protectedTokens = protectedBlocks.reduce(
    (sum, b) => addTokenCounts(sum, tokenCounts.get(b.id)!),
    { tokens: 0, method: "tiktoken-estimate" } as TokenCount,
  );

  if (protectedTokens.tokens > availableForInput) {
    // Never silently truncate critical instructions/current task: return the
    // envelope completely unchanged and flag the condition instead of guessing
    // at a "least bad" cut.
    return {
      envelope,
      inputTokensBefore: totalBefore,
      inputTokensAfter: totalBefore,
      availableForInput,
      trimEvents: [],
      criticalContentOverBudget: true,
    };
  }

  // Trimmable candidates, ranked by keep-priority (lower number = kept
  // longer), id as a deterministic tiebreaker.
  const candidates = allBlocks
    .filter((b) => !PROTECTED.has(b.class))
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let remaining = availableForInput - protectedTokens.tokens;
  const trimEvents: TrimEvent[] = [];
  const keptById = new Map<string, ContextBlock>();

  for (const block of candidates) {
    const before = tokenCounts.get(block.id)!.tokens;
    if (before <= remaining) {
      keptById.set(block.id, block);
      remaining -= before;
      continue;
    }
    if (remaining <= 0) {
      trimEvents.push({
        blockId: block.id,
        class: block.class,
        action: "dropped",
        tokensBefore: before,
        tokensAfter: 0,
        reason: "no remaining token budget",
      });
      continue;
    }
    const truncatedContent = truncateToTokenBudget(block.content, remaining);
    if (!truncatedContent) {
      trimEvents.push({
        blockId: block.id,
        class: block.class,
        action: "dropped",
        tokensBefore: before,
        tokensAfter: 0,
        reason: "remaining budget too small to fit any content",
      });
      continue;
    }
    const after = estimateTokens(truncatedContent).tokens;
    keptById.set(block.id, { ...block, content: truncatedContent });
    trimEvents.push({
      blockId: block.id,
      class: block.class,
      action: "truncated",
      tokensBefore: before,
      tokensAfter: after,
      reason: "block exceeded remaining token budget; truncated to fit",
    });
    remaining -= after;
  }

  for (const block of protectedBlocks) keptById.set(block.id, block);

  const stableBlocks = orderBlocks(envelope.stable.blocks.filter((b) => keptById.has(b.id)).map((b) => keptById.get(b.id)!));
  const dynamicBlocks = orderBlocks(envelope.dynamic.blocks.filter((b) => keptById.has(b.id)).map((b) => keptById.get(b.id)!));

  const trimmedEnvelope: ContextEnvelope = {
    stable: { blocks: stableBlocks },
    dynamic: { blocks: dynamicBlocks },
    metadata: envelope.metadata,
  };

  const inputTokensAfter = [...stableBlocks, ...dynamicBlocks].reduce(
    (sum, b) => addTokenCounts(sum, estimateTokens(b.content)),
    { tokens: 0, method: "tiktoken-estimate" } as TokenCount,
  );

  return {
    envelope: trimmedEnvelope,
    inputTokensBefore: totalBefore,
    inputTokensAfter,
    availableForInput,
    trimEvents,
    criticalContentOverBudget: false,
  };
}
