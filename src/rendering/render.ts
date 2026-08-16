/**
 * The one provider-rendering path (Phase 4 requirement: "No provider
 * identity checks scattered through Context Manager" — and, symmetrically,
 * none here either. `renderContextForProvider` branches only on
 * `capabilities.protocol`, never on `adapter.profile.id`).
 */

import { computeCacheDirectives } from "../cache/directives.js";
import { orderBlocks } from "../context/ordering.js";
import type { ContextEnvelope } from "../context/types.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { AnthropicSystemBlock, RenderedContext } from "./types.js";

/**
 * Flatten a rendered system section (either a single OpenAI-compatible joined
 * string, or an array of Anthropic content blocks) into one plain-text string.
 * Used by native-CLI context delivery (and anywhere else a caller needs the
 * system text as a single string rather than wire-shaped blocks).
 */
export function renderedSystemToText(system: RenderedContext["system"]): string {
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

export function renderContextForProvider(envelope: ContextEnvelope, adapter: ProviderAdapter): RenderedContext {
  const capabilities = adapter.getCapabilities();
  const cacheDirectives = computeCacheDirectives(envelope, capabilities);
  const directiveByBlock = new Map(cacheDirectives.map((d) => [d.blockId, d.marker]));

  const stable = orderBlocks(envelope.stable.blocks);
  const dynamic = orderBlocks(envelope.dynamic.blocks);

  const system: readonly AnthropicSystemBlock[] | string =
    capabilities.protocol === "anthropic-messages"
      ? stable.map((b): AnthropicSystemBlock => {
          const marker = directiveByBlock.get(b.id);
          return marker ? { type: "text", text: b.content, cache_control: marker } : { type: "text", text: b.content };
        })
      : stable.map((b) => b.content).join("\n\n");

  const userPrefix = dynamic.map((b) => b.content).join("\n\n");

  return { protocol: capabilities.protocol, system, userPrefix, cacheDirectives };
}
