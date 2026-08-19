/**
 * The one context-assembly path (Phase 4 requirement: "one assembly path,
 * not provider-specific reimplementations"). Every caller — a MemoryCore-
 * backed session, a caller supplying its own instructions/task/conversation
 * blocks, or both at once — funnels through `buildContextEnvelope`.
 * Provider adapters (src/rendering/) only render the result; they never
 * call MemoryCore or decide what content exists.
 */

import { orderBlocks } from "./ordering.js";
import { mapPersonaBlock, mapRecalledMemoryBlocks, mapSceneIndexBlock } from "./mapper.js";
import type { FetchedDynamicRecall, FetchedStableContent } from "./memorycore-client.js";
import type { ContextBlock, ContextEnvelope, ContextEnvelopeMetadata } from "./types.js";

export interface BuildContextEnvelopeInput {
  readonly sessionKey: string;
  readonly query: string;
  /**
   * Blocks the caller supplies directly — instructions, project context,
   * current task, recent conversation, tool results. These are never
   * sourced from MemoryCore; MemoryCore only ever supplies persona/
   * scene-index/recalled-memory.
   */
  readonly callerBlocks?: readonly ContextBlock[];
  /** Raw MemoryCore Gateway responses, already fetched (see memorycore-client.ts). Omit entirely when there's no Tencent Memory integration for this call. */
  readonly memoryCore?: {
    readonly stable: FetchedStableContent;
    readonly dynamic: FetchedDynamicRecall;
    readonly recallStrategy?: string;
  };
  /** Optional fail-closed relevance gate for launch-time memory injection. */
  readonly memoryRelevance?: { readonly query: string; readonly projectName?: string };
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
}

const CALLER_ALLOWED_STABLE_CLASSES = new Set(["instructions", "project-context", "static-tools"]);
const CALLER_ALLOWED_DYNAMIC_CLASSES = new Set(["current-task", "recent-conversation", "tool-results"]);

export function buildContextEnvelope(input: BuildContextEnvelopeInput): ContextEnvelope {
  const memoryCoreStableBlocks: ContextBlock[] = input.memoryCore
    ? [...mapPersonaBlock(input.memoryCore.stable), ...mapSceneIndexBlock(input.memoryCore.stable)]
    : [];
  const memoryCoreDynamicBlocks: ContextBlock[] = input.memoryCore
    ? mapRecalledMemoryBlocks(input.memoryCore.dynamic)
    : [];

  // MemoryCore's stable persona/scene data is user-global, not project-scoped.
  // Do not inject it into an unrelated coding task merely because the gateway
  // returned it. When a launch supplies a relevance query, retain only blocks
  // with an explicit lexical match; uncertain matches fail closed. Dynamic
  // recalls are similarly filtered, while callers that do not opt in retain
  // the historical generic envelope behavior.
  const relevant = input.memoryRelevance
    ? (block: ContextBlock): boolean => {
        const terms = `${input.memoryRelevance!.query} ${input.memoryRelevance!.projectName ?? ""}`
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((term) => term.length >= 4);
        const text = block.content.toLowerCase();
        return terms.some((term) => text.includes(term));
      }
    : undefined;
  const filteredStable = relevant ? memoryCoreStableBlocks.filter(relevant) : memoryCoreStableBlocks;
  const filteredDynamic = relevant ? memoryCoreDynamicBlocks.filter(relevant) : memoryCoreDynamicBlocks;

  const callerBlocks = input.callerBlocks ?? [];
  // Caller blocks are validated against a fixed class allowlist per section
  // — this is the enforcement mechanism behind "provider adapters/callers
  // consume/render the result rather than owning recall logic": a caller
  // cannot smuggle a "persona"/"recalled-memory" block in and pretend it
  // came from MemoryCore, and MemoryCore-sourced classes can't appear in
  // caller-supplied input.
  const callerStableBlocks = callerBlocks.filter((b) => {
    if (!CALLER_ALLOWED_STABLE_CLASSES.has(b.class)) return false;
    return true;
  });
  const callerDynamicBlocks = callerBlocks.filter((b) => CALLER_ALLOWED_DYNAMIC_CLASSES.has(b.class));

  const rejected = callerBlocks.filter(
    (b) => !CALLER_ALLOWED_STABLE_CLASSES.has(b.class) && !CALLER_ALLOWED_DYNAMIC_CLASSES.has(b.class),
  );
  if (rejected.length > 0) {
    throw new Error(
      `buildContextEnvelope: caller supplied block(s) with a MemoryCore-reserved class: ` +
      `${rejected.map((b) => `${b.id} (${b.class})`).join(", ")}. ` +
      `persona/scene-index/recalled-memory blocks may only come from the memoryCore input.`,
    );
  }

  const stableBlocks = orderBlocks([...callerStableBlocks, ...filteredStable]);
  const dynamicBlocks = orderBlocks([...callerDynamicBlocks, ...filteredDynamic]);

  const metadata: ContextEnvelopeMetadata = {
    sessionKey: input.sessionKey,
    query: input.query,
    recallStrategy: input.memoryCore?.recallStrategy,
    assembledAt: new Date().toISOString(),
    extra: input.extra,
  };

  return {
    stable: { blocks: stableBlocks },
    dynamic: { blocks: dynamicBlocks },
    metadata,
  };
}
