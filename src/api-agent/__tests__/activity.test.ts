import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, summarizeToolCall } from "../agent.js";
import type { ApiRunner } from "../runner.js";
import type { AgentTurnResult } from "../types.js";
import { ToolRegistry, textResult } from "../../mcp/tools.js";

function scriptedRunner(script: readonly AgentTurnResult[]): ApiRunner {
  let i = 0;
  return { call: async () => script[Math.min(i++, script.length - 1)]! };
}

function makeTools(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    definition: { name: "edit_file", description: "edit", inputSchema: { type: "object", properties: {} }, access: "write" },
    handler: async () => textResult("ok"),
  });
  r.register({
    definition: { name: "boom", description: "boom", inputSchema: { type: "object", properties: {} }, access: "read" },
    handler: async () => {
      throw new Error("exploded");
    },
  });
  return r;
}

describe("summarizeToolCall", () => {
  it("includes tool name, a concise target, and error status", () => {
    expect(summarizeToolCall("edit_file", '{"path":"src/x.ts"}', false)).toBe("edit_file src/x.ts");
    expect(summarizeToolCall("boom", "{}", true)).toBe("boom (error)");
    expect(summarizeToolCall("search", "not json", false)).toBe("search");
  });

  it("truncates long targets", () => {
    const long = "p".repeat(200);
    const s = summarizeToolCall("edit_file", JSON.stringify({ path: long }), false);
    expect(s.length).toBeLessThan(120);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("runAgentLoop automatic activity capture", () => {
  it("invokes onToolActivity after each tool execution with a concise summary", async () => {
    const runner = scriptedRunner([
      { content: null, toolCalls: [{ id: "c1", name: "edit_file", arguments: '{"path":"src/x.ts"}' }], finishReason: "tool_calls" },
      { content: "done", toolCalls: [], finishReason: "stop" },
    ]);
    const captured: string[] = [];
    await runAgentLoop([{ role: "user", content: "go" }], {
      runner,
      tools: makeTools(),
      onToolActivity: (tool, summary) => {
        captured.push(`${tool}:${summary}`);
      },
    });
    expect(captured).toEqual(["edit_file:edit_file src/x.ts"]);
  });

  it("marks failed tool executions in the captured summary", async () => {
    const runner = scriptedRunner([
      { content: null, toolCalls: [{ id: "c1", name: "boom", arguments: "{}" }], finishReason: "tool_calls" },
      { content: "done", toolCalls: [], finishReason: "stop" },
    ]);
    const captured: string[] = [];
    await runAgentLoop([{ role: "user", content: "go" }], {
      runner,
      tools: makeTools(),
      onToolActivity: (tool, summary) => {
        captured.push(`${tool}:${summary}`);
      },
    });
    expect(captured).toEqual(["boom:boom (error)"]);
  });
});
