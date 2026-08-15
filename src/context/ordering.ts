/**
 * Deterministic block ordering. Given the same input blocks (regardless of
 * the order they were fetched/assembled in), `orderBlocks` always returns
 * the same sequence — required so a stable section's serialized text is
 * byte-identical across turns when its content hasn't changed (prompt-cache
 * prefix stability depends on this; see src/cache/invalidation.ts).
 */

import type { ContentClass, ContextBlock, DynamicContentClass, StableContentClass } from "./types.js";

const STABLE_CLASS_ORDER: readonly StableContentClass[] = [
  "instructions",
  "project-context",
  "persona",
  "scene-index",
  "static-tools",
];

const DYNAMIC_CLASS_ORDER: readonly DynamicContentClass[] = [
  "recalled-memory",
  "current-task",
  "recent-conversation",
  "tool-results",
];

function classRank(cls: ContentClass): number {
  const stableIdx = STABLE_CLASS_ORDER.indexOf(cls as StableContentClass);
  if (stableIdx !== -1) return stableIdx;
  const dynamicIdx = DYNAMIC_CLASS_ORDER.indexOf(cls as DynamicContentClass);
  if (dynamicIdx !== -1) return STABLE_CLASS_ORDER.length + dynamicIdx;
  // Unreachable given the closed ContentClass union, but fail loud rather
  // than silently sorting an unknown class to the front.
  throw new Error(`orderBlocks: unknown content class "${cls}"`);
}

/**
 * Sort order: (1) class, per the fixed sequences above; (2) provenance
 * score descending, when present (higher-relevance recalled memories
 * first); (3) id ascending, as a total tiebreaker so the result is fully
 * deterministic even when two blocks share class and have no score.
 */
export function orderBlocks(blocks: readonly ContextBlock[]): ContextBlock[] {
  return [...blocks].sort((a, b) => {
    const rankDiff = classRank(a.class) - classRank(b.class);
    if (rankDiff !== 0) return rankDiff;

    const scoreA = a.provenance.score;
    const scoreB = b.provenance.score;
    if (scoreA !== undefined && scoreB !== undefined && scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    if (scoreA !== undefined && scoreB === undefined) return -1;
    if (scoreA === undefined && scoreB !== undefined) return 1;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
