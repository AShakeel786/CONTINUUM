import { describe, expect, it } from "vitest";
import { computeCacheDirectives } from "../directives.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import type { ContextBlock, ContextEnvelope } from "../../context/types.js";

function block(id: string, cls: ContextBlock["class"]): ContextBlock {
  return {
    id,
    class: cls,
    content: `content-${id}`,
    priority: 10,
    provenance: { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function envelope(stable: ContextBlock[]): ContextEnvelope {
  return {
    stable: { blocks: stable },
    dynamic: { blocks: [] },
    metadata: { sessionKey: "s", query: "q", assembledAt: "2026-01-01T00:00:00.000Z" },
  };
}

describe("computeCacheDirectives — Anthropic explicit caching", () => {
  it("emits exactly one ephemeral cache_control breakpoint at the end of the stable prefix for Claude", () => {
    const env = envelope([block("instr", "instructions"), block("persona", "persona"), block("scene", "scene-index")]);
    const directives = computeCacheDirectives(env, claudeProfile.capabilities);
    expect(directives).toHaveLength(1);
    expect(directives[0]!.marker).toEqual({ type: "ephemeral" });
    // Deterministic ordering (instructions, persona, scene-index) means "scene" is last.
    expect(directives[0]!.blockId).toBe("scene");
  });

  it("emits nothing for an empty stable section", () => {
    const directives = computeCacheDirectives(envelope([]), claudeProfile.capabilities);
    expect(directives).toEqual([]);
  });

  it("never emits a directive for DeepSeek (openai-automatic — no client directive concept)", () => {
    const env = envelope([block("persona", "persona")]);
    const directives = computeCacheDirectives(env, deepseekProfile.capabilities);
    expect(directives).toEqual([]);
  });

  it("emits nothing for an unsupported/none cache mode, rather than guessing at a directive", () => {
    const env = envelope([block("persona", "persona")]);
    const noneCapabilities = { ...claudeProfile.capabilities, promptCache: "none" as const };
    expect(computeCacheDirectives(env, noneCapabilities)).toEqual([]);
  });
});
