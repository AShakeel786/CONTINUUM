import { describe, expect, it } from "vitest";
import { ToolResultCache, computeCacheKey, canonicalArgs } from "../tool-cache.js";
import { ToolRegistry, textResult } from "../../mcp/tools.js";
import { runAgentLoop } from "../../api-agent/agent.js";
import type { ApiRunner } from "../../api-agent/runner.js";

describe("ToolResultCache", () => {
  it("get/set round-trips and TTL expires", () => {
    const c = new ToolResultCache({ maxEntries: 10, ttlMs: 1000 });
    c.set("k", "v", 5, 0);
    expect(c.get("k", 500)).toBe("v");
    expect(c.get("k", 1500)).toBeUndefined();
  });

  it("evicts least-recently-used beyond maxEntries", () => {
    const c = new ToolResultCache({ maxEntries: 2, ttlMs: 60_000 });
    c.set("a", "1", 0, 0);
    c.set("b", "2", 0, 0);
    c.get("a", 0);
    c.set("c", "3", 0, 0);
    expect(c.get("a", 0)).toBe("1");
    expect(c.get("b", 0)).toBeUndefined();
    expect(c.get("c", 0)).toBe("3");
    expect(c.telemetry.evictions).toBe(1);
  });
});

describe("canonicalArgs / computeCacheKey", () => {
  it("canonicalizes args order-independently", () => {
    expect(canonicalArgs({ b: 2, a: 1 })).toBe(canonicalArgs({ a: 1, b: 2 }));
  });

  it("returns undefined for an unknown scope fingerprint (fail-safe)", () => {
    expect(computeCacheKey("project_list", "{}", "project", undefined)).toBeUndefined();
  });

  it("produces a stable key and a distinct key for a different scope fingerprint", () => {
    const k1 = computeCacheKey("project_list", "{}", "project", "fp1")!;
    const k2 = computeCacheKey("project_list", "{}", "project", "fp1")!;
    const k3 = computeCacheKey("project_list", "{}", "project", "fp2")!;
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});

describe("agent-loop cache integration", () => {
  it("caches a cacheable read-only tool (handler runs once for repeated identical calls)", async () => {
    let callCount = 0;
    const tools = new ToolRegistry();
    tools.register({
      definition: { name: "probe", description: "probe", inputSchema: { type: "object", properties: {} }, access: "read", cacheScope: "global" },
      handler: async () => { callCount += 1; return textResult("value"); },
    });
    const runner: ApiRunner = {
      call: async (messages) => {
        const n = messages.filter((m) => m.role === "assistant" && m.toolCalls?.length).length;
        return n < 2 ? { content: null, toolCalls: [{ id: `c${n}`, name: "probe", arguments: "{}" }], finishReason: "tool_calls" } : { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };
    const cache = new ToolResultCache();
    await runAgentLoop([{ role: "user", content: "go" }], { runner, tools, cache, scopeProvider: {} });
    expect(callCount).toBe(1);
    expect(cache.telemetry.hits).toBe(1);
    expect(cache.telemetry.misses).toBe(1);
  });

  it("never caches a write tool (always executes)", async () => {
    let callCount = 0;
    const tools = new ToolRegistry();
    tools.register({
      definition: { name: "write", description: "w", inputSchema: { type: "object", properties: {} }, access: "write" },
      handler: async () => { callCount += 1; return textResult("ok"); },
    });
    const runner: ApiRunner = {
      call: async (messages) => {
        const n = messages.filter((m) => m.role === "assistant" && m.toolCalls?.length).length;
        return n < 2 ? { content: null, toolCalls: [{ id: `c${n}`, name: "write", arguments: "{}" }], finishReason: "tool_calls" } : { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };
    await runAgentLoop([{ role: "user", content: "go" }], { runner, tools, cache: new ToolResultCache(), scopeProvider: {} });
    expect(callCount).toBe(2);
  });

  it("fails safe: session scope with no sessionId → miss each time", async () => {
    let callCount = 0;
    const tools = new ToolRegistry();
    tools.register({
      definition: { name: "session_state", description: "s", inputSchema: { type: "object", properties: { sessionId: { type: "string" } } }, access: "read", cacheScope: "session" },
      handler: async () => { callCount += 1; return textResult("state"); },
    });
    const runner: ApiRunner = {
      call: async (messages) => {
        const n = messages.filter((m) => m.role === "assistant" && m.toolCalls?.length).length;
        return n < 2 ? { content: null, toolCalls: [{ id: `c${n}`, name: "session_state", arguments: "{}" }], finishReason: "tool_calls" } : { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };
    await runAgentLoop([{ role: "user", content: "go" }], { runner, tools, cache: new ToolResultCache(), scopeProvider: { sessionFingerprint: async () => "rev1" } });
    expect(callCount).toBe(2);
  });
});
