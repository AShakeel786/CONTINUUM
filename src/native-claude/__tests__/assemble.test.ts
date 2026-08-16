/**
 * Proves the memory-blind gap (R-17) can be closed for native Claude:
 * real (mocked) MemoryCore recall flows through the same Context Manager
 * pipeline every other path uses and comes out the other end as an
 * Anthropic-shaped, cache-annotated, token-budgeted system prompt — with
 * no proxy, no DeepSeek, and no Tencent-launcher code involved at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleNativeClaudeContext } from "../assemble.js";
import { secretRef } from "../../providers/secrets.js";
import type { AnthropicSystemBlock } from "../../rendering/types.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const memoryCoreCfg = {
  baseUrl: "http://127.0.0.1:8420",
  serviceToken: secretRef("TEST_NATIVE_CLAUDE_TOKEN"),
  serviceId: "default",
  teamId: "team-pdbmmxm8iv",
  userId: "user-x",
  agentId: "agt-pdbxkgmtb1",
  taskId: "task-x",
  sessionId: "sess-native-claude-1",
};

describe("assembleNativeClaudeContext — closing the memory-blind gap for native Claude", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_NATIVE_CLAUDE_TOKEN;
  });

  it("assembles real MemoryCore recall into an Anthropic-shaped, cache-annotated, budgeted context", async () => {
    process.env.TEST_NATIVE_CLAUDE_TOKEN = "sk-mem-native-claude-fixture";
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v3/core/read")) {
        return jsonResponse({ code: 0, data: { content: "User is a backend engineer who prefers concise answers." } });
      }
      if (u.endsWith("/v3/scenario/ls")) {
        return jsonResponse({ code: 0, data: { entries: [{ path: "scenes/deploy-runbook.md", summary: "Deployment runbook" }] } });
      }
      if (u.endsWith("/v3/atomic/search")) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{ id: "mem-42", type: "instruction", content: "Always run tests before deploying.", score: 0.81 }],
          },
        });
      }
      throw new Error(`unexpected URL in native-claude harness test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await assembleNativeClaudeContext({
      sessionKey: "sess-native-claude-1",
      query: "how do I deploy this service",
      memoryCore: memoryCoreCfg,
    });

    // 1. Real MemoryCore content made it into the envelope.
    expect(result.envelope.stable.blocks.some((b) => b.class === "persona")).toBe(true);
    expect(result.envelope.stable.blocks.some((b) => b.class === "scene-index")).toBe(true);
    expect(result.envelope.dynamic.blocks.some((b) => b.provenance.sourceId === "mem-42")).toBe(true);

    // 2. Token budgeting ran (no trimming needed for this small fixture).
    expect(result.budget.criticalContentOverBudget).toBe(false);
    expect(result.budget.inputTokensAfter.tokens).toBeGreaterThan(0);

    // 3. Rendered into real Anthropic wire shape — ready for a native Claude call.
    expect(result.rendered.protocol).toBe("anthropic-messages");
    const system = result.rendered.system as readonly AnthropicSystemBlock[];
    expect(Array.isArray(system)).toBe(true);
    expect(system.some((b) => b.text.includes("backend engineer"))).toBe(true);
    expect(result.rendered.userPrefix).toContain("Always run tests before deploying.");

    // 4. Anthropic cache directive was computed for the stable prefix.
    expect(result.rendered.cacheDirectives.length).toBeGreaterThan(0);
  });

  it("still produces a valid (empty-stable) context when MemoryCore has nothing to recall — no crash on a cold profile", async () => {
    process.env.TEST_NATIVE_CLAUDE_TOKEN = "sk-mem-native-claude-fixture";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/v3/core/read")) return jsonResponse({ code: 0, data: { content: "" } });
        if (u.endsWith("/v3/scenario/ls")) return jsonResponse({ code: 0, data: { entries: [] } });
        if (u.endsWith("/v3/atomic/search")) return jsonResponse({ code: 0, data: { items: [] } });
        throw new Error(`unexpected URL: ${u}`);
      }),
    );

    const result = await assembleNativeClaudeContext({
      sessionKey: "sess-cold",
      query: "hello",
      memoryCore: memoryCoreCfg,
    });

    expect(result.envelope.stable.blocks).toHaveLength(0);
    expect(result.envelope.dynamic.blocks).toHaveLength(0);
    expect(result.rendered.system).toEqual([]);
    expect(result.rendered.userPrefix).toBe("");
  });

  it("budgets against a real Claude context window, not an arbitrary number", async () => {
    process.env.TEST_NATIVE_CLAUDE_TOKEN = "sk-mem-native-claude-fixture";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/v3/core/read")) return jsonResponse({ code: 0, data: { content: "Persona." } });
        if (u.endsWith("/v3/scenario/ls")) return jsonResponse({ code: 0, data: { entries: [] } });
        if (u.endsWith("/v3/atomic/search")) return jsonResponse({ code: 0, data: { items: [] } });
        throw new Error(`unexpected URL: ${u}`);
      }),
    );

    const result = await assembleNativeClaudeContext({
      sessionKey: "sess-budget-check",
      query: "hi",
      memoryCore: memoryCoreCfg,
      outputTokenReserve: 1000,
    });

    expect(result.budget.availableForInput).toBe(200_000 - 1000);
  });
});
