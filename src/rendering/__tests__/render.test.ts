import { describe, expect, it } from "vitest";
import { renderContextForProvider } from "../render.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import type { ContextBlock, ContextEnvelope } from "../../context/types.js";

function block(id: string, cls: ContextBlock["class"], content: string): ContextBlock {
  return { id, class: cls, content, priority: 10, provenance: { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z" } };
}

function envelope(stable: ContextBlock[], dynamic: ContextBlock[]): ContextEnvelope {
  return {
    stable: { blocks: stable },
    dynamic: { blocks: dynamic },
    metadata: { sessionKey: "s", query: "q", assembledAt: "2026-01-01T00:00:00.000Z" },
  };
}

const fixture = envelope(
  [block("instr", "instructions", "Be concise."), block("persona", "persona", "User likes brevity.")],
  [block("mem-1", "recalled-memory", "Discussed X yesterday.")],
);

describe("renderContextForProvider — Claude", () => {
  const claudeAdapter = createProviderAdapter(claudeProfile);

  it("renders stable content as an array of Anthropic content blocks, one per ContextBlock", () => {
    const rendered = renderContextForProvider(fixture, claudeAdapter);
    expect(Array.isArray(rendered.system)).toBe(true);
    const system = rendered.system as { type: string; text: string }[];
    expect(system).toHaveLength(2);
    expect(system[0]!.text).toBe("Be concise.");
    expect(system[1]!.text).toBe("User likes brevity.");
  });

  it("attaches the cache_control ephemeral marker to the last stable block only", () => {
    const rendered = renderContextForProvider(fixture, claudeAdapter);
    const system = rendered.system as readonly { cache_control?: { type: string } }[];
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("renders dynamic content as a joined user-prefix string", () => {
    const rendered = renderContextForProvider(fixture, claudeAdapter);
    expect(rendered.userPrefix).toContain("Discussed X yesterday.");
  });

  it("reports the cache directives it applied", () => {
    const rendered = renderContextForProvider(fixture, claudeAdapter);
    expect(rendered.cacheDirectives).toHaveLength(1);
    expect(rendered.cacheDirectives[0]!.blockId).toBe("persona");
  });
});

describe("renderContextForProvider — DeepSeek", () => {
  const deepseekAdapter = createProviderAdapter(deepseekProfile);

  it("renders stable content as a single joined string, not a block array", () => {
    const rendered = renderContextForProvider(fixture, deepseekAdapter);
    expect(typeof rendered.system).toBe("string");
    expect(rendered.system as string).toContain("Be concise.");
    expect(rendered.system as string).toContain("User likes brevity.");
  });

  it("emits no cache directives (openai-automatic — nothing for the client to attach)", () => {
    const rendered = renderContextForProvider(fixture, deepseekAdapter);
    expect(rendered.cacheDirectives).toEqual([]);
  });
});

describe("renderContextForProvider — same envelope, same content selection across providers", () => {
  it("both renderers see identical underlying content — only serialization differs", () => {
    const claudeAdapter = createProviderAdapter(claudeProfile);
    const deepseekAdapter = createProviderAdapter(deepseekProfile);
    const claudeRendered = renderContextForProvider(fixture, claudeAdapter);
    const deepseekRendered = renderContextForProvider(fixture, deepseekAdapter);

    const claudeText = (claudeRendered.system as readonly { text: string }[]).map((b) => b.text).join("\n\n");
    expect(claudeText).toBe(deepseekRendered.system as string);
    expect(claudeRendered.userPrefix).toBe(deepseekRendered.userPrefix);
  });
});
