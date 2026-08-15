/**
 * Cache directive emission. Branches only on the provider's *capability*
 * (`promptCache`, from the Phase 3 provider profile), never on provider
 * identity — the same principle the provider adapter itself follows.
 *
 * Grounded in what the codebase actually does today: a repo-wide search
 * found MemoryProxy only ever *passes through* an existing `cache_control`
 * marker the Claude Code CLI already attached
 * (`MemoryProxy/src/injection/adapters/anthropic.ts`) — nothing in the
 * codebase constructs one. Anthropic's Messages API documents
 * `{"type": "ephemeral"}` as the only cache_control marker shape; that's
 * what's emitted here — not invented, and not more than that (no `ttl`
 * override, which the brief's "do not over-engineer" rules out for a first
 * pass with no evidence CONTINUUM needs anything beyond the default TTL).
 */

import type { ProviderCapabilities } from "../providers/types.js";
import { orderBlocks } from "../context/ordering.js";
import type { ContextEnvelope } from "../context/types.js";
import type { CacheDirective } from "./types.js";

/**
 * Anthropic's own guidance: a single cache_control breakpoint at the END of
 * the stable/cacheable prefix caches everything up to and including that
 * point. One directive is sufficient and is what's emitted here — not one
 * per stable block, which would be both unsupported (Anthropic caps
 * breakpoints per request) and pointless (the whole prefix up to the last
 * breakpoint is what gets cached, not each block independently).
 */
export function computeCacheDirectives(
  envelope: ContextEnvelope,
  capabilities: ProviderCapabilities,
): readonly CacheDirective[] {
  if (capabilities.promptCache !== "anthropic-explicit") {
    // openai-automatic (DeepSeek): caching is server-side and automatic —
    // no client directive exists to emit. "none": nothing to do. Either
    // way, an empty directive list is the honest answer, not a guess.
    return [];
  }
  if (envelope.stable.blocks.length === 0) return [];

  const ordered = orderBlocks(envelope.stable.blocks);
  const last = ordered[ordered.length - 1]!;
  return [{ blockId: last.id, marker: { type: "ephemeral" } }];
}
