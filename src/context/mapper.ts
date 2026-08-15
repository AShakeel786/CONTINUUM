/**
 * Maps raw MemoryCore Gateway responses into provenance-tagged
 * `ContextBlock`s. Kept separate from `memorycore-client.ts` (HTTP) and
 * `envelope.ts` (assembly) so each has one job.
 */

import type { FetchedDynamicRecall, FetchedStableContent } from "./memorycore-client.js";
import type { ContextBlock } from "./types.js";

const NOW = () => new Date().toISOString();

/** L3 persona → one "persona" block, when present. */
export function mapPersonaBlock(stable: FetchedStableContent): ContextBlock[] {
  if (!stable.persona || !stable.persona.content.trim()) return [];
  return [
    {
      id: "memorycore:persona:l3",
      class: "persona",
      content: `<user-persona>\n${stable.persona.content.trim()}\n</user-persona>`,
      priority: 10,
      provenance: {
        source: "memorycore-gateway:/v3/core/read",
        fetchedAt: NOW(),
      },
    },
  ];
}

/** L2 scene index → one "scene-index" block (path list, not full content — matches the existing MemoryProxy index-only pattern). */
export function mapSceneIndexBlock(stable: FetchedStableContent): ContextBlock[] {
  if (stable.sceneIndex.length === 0) return [];
  const lines = stable.sceneIndex.map((e) => (e.summary ? `- \`${e.path}\` — ${e.summary}` : `- \`${e.path}\``));
  return [
    {
      id: "memorycore:scene-index:l2",
      class: "scene-index",
      content: `<scene-index>\n${lines.join("\n")}\n</scene-index>`,
      priority: 20,
      provenance: {
        source: "memorycore-gateway:/v3/scenario/ls",
        fetchedAt: NOW(),
        score: undefined,
      },
    },
  ];
}

/**
 * L1 relevant memories → one block per recalled item, so the Token Manager
 * can trim individually (lowest-score first), not all-or-nothing.
 */
export function mapRecalledMemoryBlocks(dynamic: FetchedDynamicRecall): ContextBlock[] {
  return dynamic.items.map((item): ContextBlock => ({
    id: `memorycore:recall:${item.id}`,
    class: "recalled-memory",
    content: item.type ? `[${item.type}] ${item.content}` : item.content,
    // Lower priority number = dropped later. Recalled memories are the most
    // expendable content class by design (per auto-recall.ts's own framing:
    // "仅作为参考", reference-only) — highest priority *number* (dropped first).
    priority: 80,
    provenance: {
      source: "memorycore-gateway:/v3/atomic/search",
      sourceId: item.id,
      score: item.score,
      fetchedAt: NOW(),
    },
  }));
}
