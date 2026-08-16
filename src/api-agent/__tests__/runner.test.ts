import { describe, expect, it } from "vitest";
import { createApiRunner, type FetchLike } from "../runner.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { ApiAgentError, type AgentMessage } from "../types.js";
import type { ProviderManifest } from "../../providers/manifest.js";

const grokManifest: ProviderManifest = {
  schemaVersion: 1, id: "grok", displayName: "Grok", protocol: "openai-compatible",
  baseUrl: "https://api.x.ai/v1", auth: { kind: "api-key", envVar: "XAI_API_KEY" }, models: { default: "grok-3" },
};
const anthropicManifest: ProviderManifest = {
  schemaVersion: 1, id: "ant", displayName: "Anthropic-like", protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com", auth: { kind: "api-key", envVar: "ANTHROPIC_API_KEY" }, models: { default: "claude-x" },
};

function fakeFetch(respond: (url: string, body: string) => { status: number; body: string }): FetchLike {
  return async (url, init) => {
    const { status, body } = respond(url, init.body);
    return { ok: status >= 200 && status < 300, status, body };
  };
}

const msgs: AgentMessage[] = [{ role: "user", content: "hello" }];

describe("OpenAI-compatible runner", () => {
  it("posts to /chat/completions with Bearer auth and parses content + tool calls", async () => {
    let captured = "";
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, {
      fetch: fakeFetch((url, body) => {
        captured = `${url}\n${body}`;
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "hi", tool_calls: [{ id: "t1", function: { name: "memory_search", arguments: "{\"query\":\"x\"}" } }] }, finish_reason: "tool_calls" }] }) };
      }),
    });
    const result = await runner.call(msgs, []);
    delete process.env.XAI_API_KEY;

    expect(captured).toContain("/chat/completions");
    expect(captured).toContain("grok-3");
    expect(result.content).toBe("hi");
    expect(result.toolCalls).toEqual([{ id: "t1", name: "memory_search", arguments: "{\"query\":\"x\"}" }]);
  });

  it("throws a clear error on a non-2xx (bad key/endpoint)", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, { fetch: async () => ({ ok: false, status: 401, body: "invalid key" }) });
    await expect(runner.call(msgs, [])).rejects.toThrow(ApiAgentError);
    await expect(runner.call(msgs, [])).rejects.toThrow(/401/);
    delete process.env.XAI_API_KEY;
  });
});

describe("Anthropic-compatible runner", () => {
  it("posts to /v1/messages and parses text + tool_use blocks", async () => {
    let captured = "";
    const adapter = createProviderAdapter(manifestToProfile(anthropicManifest));
    process.env.ANTHROPIC_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, {
      fetch: fakeFetch((url, body) => {
        captured = `${url}\n${body}`;
        return { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "answer" }, { type: "tool_use", id: "tu1", name: "memory_recall", input: {} }], stop_reason: "tool_use" }) };
      }),
    });
    const result = await runner.call([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], []);
    delete process.env.ANTHROPIC_API_KEY;

    expect(captured).toContain("/v1/messages");
    expect(captured).toContain("claude-x");
    expect(result.content).toBe("answer");
    expect(result.toolCalls).toEqual([{ id: "tu1", name: "memory_recall", arguments: "{}" }]);
  });
});
