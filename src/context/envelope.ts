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

  const stableBlocks = orderBlocks([...callerStableBlocks, ...memoryCoreStableBlocks]);
  const dynamicBlocks = orderBlocks([...callerDynamicBlocks, ...memoryCoreDynamicBlocks]);

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
