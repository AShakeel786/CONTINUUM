import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent.js";
import type { AgentMessage, AgentTurnResult } from "../types.js";
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

  it("returns a graceful partial answer on max-iterations (never a bare error)", async () => {
    const runner: ApiRunner = {
      // Each turn asks for a DIFFERENT read so stall detection does not fire first.
      call: async () => ({ content: "still working", toolCalls: [{ id: `c${Math.random()}`, name: "echo", arguments: JSON.stringify({ n: Math.random() }) }], finishReason: "tool_calls" }),
    };
    const result = await runAgentLoop(initial, { runner, tools: makeTools(), limits: { maxIterations: 3, timeoutMs: 60_000, stallThreshold: 99, maxStallSignals: 0 } });
    expect(result.stopReason).toBe("max-iterations");
    expect(result.iterations).toBe(3);
    expect(result.finalContent).toContain("stopped before finishing");
    expect(result.finalContent).toContain("iteration limit");
  });

  it("returns a graceful partial answer on timeout", async () => {
    const runner: ApiRunner = { call: async () => ({ content: null, toolCalls: [], finishReason: "stop" }) };
    let t = 0;
    const result = await runAgentLoop(initial, { runner, tools: makeTools(), now: () => (t += 100_000), limits: { maxIterations: 5, timeoutMs: 1000 } });
    expect(result.stopReason).toBe("timeout");
    expect(result.finalContent).toContain("time limit");
  });

  it("detects a repeated identical tool call and stops with a stall reason before maxIterations", async () => {
    let calls = 0;
    const runner: ApiRunner = {
      call: async () => {
        calls += 1;
        // Always the exact same call + same result.
        return { content: null, toolCalls: [{ id: `c${calls}`, name: "echo", arguments: "{\"x\":1}" }], finishReason: "tool_calls" };
      },
    };
    const events: string[] = [];
    const result = await runAgentLoop(initial, {
      runner, tools: makeTools(),
      limits: { maxIterations: 25, timeoutMs: 60_000, stallThreshold: 3, maxStallSignals: 1 },
      onEvent: (e, d) => { if (e === "stall") events.push(d); },
    });
    expect(result.stopReason).toBe("stalled");
    expect(result.iterations).toBeLessThan(25);
    expect(events.length).toBe(1); // one stall signal injected, then gave up
  });

  it("still completes a legitimate multi-step task that varies its actions", async () => {
    const script: AgentTurnResult[] = [
      { content: null, toolCalls: [{ id: "a", name: "echo", arguments: "{\"step\":1}" }], finishReason: "tool_calls" },
      { content: null, toolCalls: [{ id: "b", name: "echo", arguments: "{\"step\":2}" }], finishReason: "tool_calls" },
      { content: null, toolCalls: [{ id: "c", name: "echo", arguments: "{\"step\":3}" }], finishReason: "tool_calls" },
      { content: "all done", toolCalls: [], finishReason: "stop" },
    ];
    const result = await runAgentLoop([{ role: "user", content: "do the three-step task" }], { runner: scriptedRunner(script), tools: makeTools() });
    expect(result.stopReason).toBe("final");
    expect(result.finalContent).toBe("all done");
    expect(result.toolCalls).toBe(3);
  });

  it("withholds tools on the first turn for a conversational/absent intent", async () => {
    const toolLists: number[] = [];
    const runner: ApiRunner = {
      call: async (_msgs, tools) => { toolLists.push(tools.length); return { content: "hello! what would you like to work on?", toolCalls: [], finishReason: "stop" }; },
    };
    const result = await runAgentLoop([{ role: "user", content: "hi" }], { runner, tools: makeTools(), taskIntent: "conversational" });
    expect(result.stopReason).toBe("final");
    expect(toolLists[0]).toBe(0); // no tools offered on the greeting turn
  });
});
