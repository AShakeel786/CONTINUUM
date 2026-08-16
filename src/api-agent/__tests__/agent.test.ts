import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent.js";
import { AgentLoopError, type AgentMessage, type AgentTurnResult } from "../types.js";
import type { ApiRunner } from "../runner.js";
import { ToolRegistry, textResult } from "../../mcp/tools.js";

function scriptedRunner(script: readonly AgentTurnResult[]): ApiRunner {
  let i = 0;
  return { call: async () => script[Math.min(i++, script.length - 1)]! };
}

function makeTools(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    definition: { name: "echo", description: "echo", inputSchema: { type: "object", properties: {} }, access: "read" },
    handler: async (args) => textResult(JSON.stringify(args)),
  });
  r.register({
    definition: { name: "fail", description: "fail", inputSchema: { type: "object", properties: {} }, access: "read" },
    handler: async () => { throw new Error("boom"); },
  });
  return r;
}

const initial: AgentMessage[] = [{ role: "user", content: "go" }];

describe("runAgentLoop", () => {
  it("single turn: no tool calls → returns the final answer", async () => {
    const runner = scriptedRunner([{ content: "done", toolCalls: [], finishReason: "stop" }]);
    const result = await runAgentLoop(initial, { runner, tools: makeTools() });
    expect(result.finalContent).toBe("done");
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it("multi-turn: model → tool → result → final answer", async () => {
    const runner = scriptedRunner([
      { content: null, toolCalls: [{ id: "c1", name: "echo", arguments: "{\"a\":1}" }], finishReason: "tool_calls" },
      { content: "final", toolCalls: [], finishReason: "stop" },
    ]);
    const result = await runAgentLoop(initial, { runner, tools: makeTools() });
    expect(result.finalContent).toBe("final");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
  });

  it("surfaces a tool failure without inventing a result", async () => {
    let toolResult = "";
    const runner = scriptedRunner([
      { content: null, toolCalls: [{ id: "c1", name: "fail", arguments: "{}" }], finishReason: "tool_calls" },
      { content: "ok", toolCalls: [], finishReason: "stop" },
    ]);
    await runAgentLoop(initial, {
      runner, tools: makeTools(), onEvent: (_e, d) => { toolResult += d; },
    });
    expect(toolResult).toContain("[tool failure]");
  });

  it("throws AgentLoopError on max-iterations", async () => {
    const runner: ApiRunner = {
      call: async () => ({ content: null, toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }], finishReason: "tool_calls" }),
    };
    await expect(runAgentLoop(initial, { runner, tools: makeTools(), limits: { maxIterations: 3, timeoutMs: 60_000 } })).rejects.toThrow(AgentLoopError);
  });

  it("throws AgentLoopError on timeout", async () => {
    const runner: ApiRunner = { call: async () => ({ content: null, toolCalls: [], finishReason: "stop" }) };
    let t = 0;
    await expect(runAgentLoop(initial, { runner, tools: makeTools(), now: () => (t += 100_000), limits: { maxIterations: 5, timeoutMs: 1000 } })).rejects.toThrow(AgentLoopError);
  });
});
