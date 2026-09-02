import { describe, expect, it } from "vitest";
import { classifyTaskIntent, buildInitialMessages, runApiAgent } from "../run.js";
import type { RenderedContext } from "../../rendering/types.js";
import { ToolRegistry, textResult } from "../../mcp/tools.js";
import type { ApiRunner } from "../runner.js";
import type { ProviderAdapter } from "../../providers/types.js";
import type { AgentTurnResult } from "../types.js";

const rendered: RenderedContext = {
  protocol: "openai-compatible",
  system: "You are a coding agent. Tool surface: local coding harness enabled.",
  userPrefix: "",
  cacheDirectives: [],
};

function codingTools(): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of ["exec", "read_file", "search_files"]) {
    r.register({
      definition: { name, description: name, inputSchema: { type: "object", properties: {} }, access: "read" },
      handler: async () => textResult("output"),
    });
  }
  return r;
}

const fakeAdapter = { profile: { id: "local", displayName: "Local" } } as unknown as ProviderAdapter;

describe("classifyTaskIntent", () => {
  it("treats blank / placeholder goals as absent", () => {
    for (const g of ["", "  ", "(untitled)", "N/A", "none", "chat"]) expect(classifyTaskIntent(g)).toBe("absent");
  });
  it("treats greetings / smalltalk as conversational", () => {
    for (const g of ["hi", "hello", "hey there", "thanks!", "good morning", "are you there?", "ping"]) {
      expect(classifyTaskIntent(g)).toBe("conversational");
    }
  });
  it("treats anything with a real task verb as a task", () => {
    for (const g of ["fix the login bug", "add a test for X", "hello, can you refactor the parser", "investigate the flaky CI"]) {
      expect(classifyTaskIntent(g)).toBe("task");
    }
  });
});

describe("buildInitialMessages — no-task guardrails", () => {
  it("an absent goal produces a short greet-and-ask directive (not a standing no-tools order)", () => {
    const msgs = buildInitialMessages(rendered, "(untitled)");
    const user = msgs.find((m) => m.role === "user")!.content;
    expect(user).toMatch(/without stating a task/i);
    expect(user).toMatch(/ask what|what they'd like/i);
    expect(user.length).toBeLessThan(200); // short — applies to this turn only
  });
  it("a real task passes the query through unchanged", () => {
    const msgs = buildInitialMessages(rendered, "fix the parser");
    expect(msgs.find((m) => m.role === "user")!.content).toBe("fix the parser");
  });
});

describe("runApiAgent — hello / blank goal never touches coding tools", () => {
  it("answers a greeting directly with zero tool calls", async () => {
    const offered: number[] = [];
    const runner: ApiRunner = {
      call: async (_m, tools) => { offered.push(tools.length); return { content: "Hi! What would you like to work on?", toolCalls: [], finishReason: "stop" }; },
    };
    const res = await runApiAgent({ adapter: fakeAdapter, runner, tools: codingTools(), rendered, query: "hello" });
    expect(res.stopReason).toBe("final");
    expect(res.toolCalls).toBe(0);
    expect(offered[0]).toBe(0); // no coding tools on the first turn
    expect(res.finalContent).toContain("What would you like to work on");
  });

  it("a blank task goal does not trigger a repo scan", async () => {
    const toolNamesCalled: string[] = [];
    const tools = codingTools();
    const orig = tools.call.bind(tools);
    tools.call = async (name, args) => { toolNamesCalled.push(name); return orig(name, args); };
    const runner: ApiRunner = { call: async () => ({ content: "No task specified — what should I do?", toolCalls: [], finishReason: "stop" }) };
    const res = await runApiAgent({ adapter: fakeAdapter, runner, tools, rendered, query: "" });
    expect(res.stopReason).toBe("final");
    expect(toolNamesCalled).toEqual([]);
  });
});

describe("runApiAgent — graceful partial + stall", () => {
  it("max iterations returns accumulated findings, not a bare error", async () => {
    let i = 0;
    const runner: ApiRunner = {
      call: async () => { i += 1; return { content: `working ${i}`, toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `f${i}.ts` }) }], finishReason: "tool_calls" }; },
    };
    const res = await runApiAgent({
      adapter: fakeAdapter, runner, tools: codingTools(), rendered, query: "review the whole codebase",
      limits: { maxIterations: 4, timeoutMs: 60_000, stallThreshold: 99, maxStallSignals: 0 },
    });
    expect(res.stopReason).toBe("max-iterations");
    expect(res.finalContent).toContain("Progress so far");
    expect(res.finalContent).toContain("read_file f1.ts");
    expect(res.finalContent).not.toBe("agent loop exceeded 25 iterations");
  });

  it("a retrieval-missing tool-output does not cause a rediscovery loop", async () => {
    // First turn: model 'runs tests', gets a tool-output:// ref it can't fetch.
    // Second turn: model tries tool_output_retrieve → miss → must not re-run.
    const tools = new ToolRegistry();
    tools.register({
      definition: { name: "exec", description: "e", inputSchema: { type: "object", properties: {} }, access: "read" },
      handler: async () => textResult("large output\n[raw output retained: tool-output://deadbeef]"),
    });
    tools.register({
      definition: { name: "tool_output_retrieve", description: "r", inputSchema: { type: "object", properties: { id: {} } }, access: "read" },
      handler: async () => textResult("tool-output deadbeef is no longer available. Do NOT re-run the command to rediscover it — the optimized summary you already received in the conversation is the retained record.", true),
    });
    let retrieveMissMsg = "";
    const runner: ApiRunner = {
      call: async (msgs) => {
        const toolMsgs = msgs.filter((m) => m.role === "tool");
        if (toolMsgs.length === 0) return { content: null, toolCalls: [{ id: "1", name: "exec", arguments: "{}" }], finishReason: "tool_calls" };
        if (toolMsgs.length === 1) return { content: null, toolCalls: [{ id: "2", name: "tool_output_retrieve", arguments: "{\"id\":\"deadbeef\"}" }], finishReason: "tool_calls" };
        retrieveMissMsg = (toolMsgs.at(-1)!).content;
        return { content: "Working from the summary I already have.", toolCalls: [], finishReason: "stop" };
      },
    };
    const res = await runApiAgent({ adapter: fakeAdapter, runner, tools, rendered, query: "run the tests and report failures" });
    expect(res.stopReason).toBe("final");
    expect(retrieveMissMsg).toMatch(/do not re-run/i);
  });
});
