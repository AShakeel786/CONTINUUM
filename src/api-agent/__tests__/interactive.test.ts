import { describe, expect, it } from "vitest";
import { runInteractiveApiSession, type InteractiveIo } from "../interactive.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { localOrnith15Manifest } from "../../providers/presets.js";
import { ToolRegistry, textResult } from "../../mcp/tools.js";
import type { ApiRunner } from "../runner.js";
import type { AgentTurnResult, RunnerCallOptions } from "../types.js";
import type { RenderedContext } from "../../rendering/types.js";

const adapter = createProviderAdapter(manifestToProfile(localOrnith15Manifest));
const rendered: RenderedContext = { protocol: "openai-compatible", system: "You are a coding agent.", userPrefix: "", cacheDirectives: [] };

function tools(): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of ["exec", "read_file", "memory_recall", "memory_capture", "session_update"]) {
    r.register({ definition: { name: n, description: n, inputSchema: { type: "object", properties: {} }, access: "read" }, handler: async () => textResult("ok") });
  }
  return r;
}

/** Scripts model turns; records the tool schema it was offered each call. */
function scriptRunner(turns: (AgentTurnResult | ((n: number) => AgentTurnResult))[]): { runner: ApiRunner; offered: number[]; calls: number } {
  const state = { offered: [] as number[], calls: 0 };
  const runner: ApiRunner = {
    async call(_msgs, toolDefs, opts?: RunnerCallOptions) {
      state.offered.push(toolDefs.length);
      const t = turns[Math.min(state.calls, turns.length - 1)]!;
      const res = typeof t === "function" ? t(state.calls) : t;
      state.calls += 1;
      if (opts?.onChunk && res.content) opts.onChunk(res.content);
      return res;
    },
  };
  return { runner, ...state, get calls() { return state.calls; } } as never;
}

/** Scripted IO: `inputs` are consumed in order; null ends input (EOF). */
function fakeIo(inputs: (string | null)[]): InteractiveIo & { out: string; statuses: string[] } {
  const st = { out: "", statuses: [] as string[] };
  let i = 0;
  return {
    async readLine() { return i < inputs.length ? inputs[i++]! : null; },
    write(t: string) { st.out += t; },
    status(l: string) { if (l) st.statuses.push(l); },
    clearStatus() {},
    get out() { return st.out; },
    get statuses() { return st.statuses; },
  } as never;
}

const svc = async () => ({ state: "running-owned", pid: 4321, endpoint: "http://127.0.0.1:8080/v1/models" });
const baseInfo = {
  sessionId: "sess-1", projectLabel: "passcars", projectPath: "/Users/home/developer/CARS",
  providerId: "local-ornith15", model: "/models/ornith", memoryScope: "project-abc", service: svc,
};

describe("interactive Direct-API session", () => {
  it("blank task → the model asks what to work on, with NO tools, and stays interactive", async () => {
    const { runner, offered } = scriptRunner([
      { content: "Hi! What would you like to work on?", toolCalls: [], finishReason: "stop" },
      { content: "Here's a slugify function …", toolCalls: [], finishReason: "stop" },
    ]);
    const io = fakeIo(["write a slugify function", "/exit"]);
    const out = await runInteractiveApiSession({ adapter, tools: tools(), rendered, initialQuery: "", runnerFactory: () => runner, io, info: baseInfo });
    expect(offered[0]).toBe(0); // turn 0 (blank task) → no tools
    expect(io.out).toContain("What would you like to work on");
    expect(io.out).toContain("slugify");
    expect(out.endedBy).toBe("exit");
    expect(out.turns).toBe(2);
  });

  it("a greeting is answered with zero tools; a follow-up coding turn gets the tool schema", async () => {
    const { runner, offered } = scriptRunner([
      { content: "Hello!", toolCalls: [], finishReason: "stop" },
      { content: null, toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }], finishReason: "tool_calls" },
      { content: "Done, here is the fix.", toolCalls: [], finishReason: "stop" },
    ]);
    const io = fakeIo(["fix the bug in parser.ts", "/exit"]);
    await runInteractiveApiSession({ adapter, tools: tools(), rendered, initialQuery: "hello", runnerFactory: () => runner, io, info: baseInfo });
    expect(offered[0]).toBe(0);               // greeting turn: no tools
    expect(offered[1]).toBeGreaterThan(0);    // coding follow-up: tools offered
    // …and the harness-only tools (memory_capture, session_update) are filtered out.
    expect(offered[1]).toBeLessThan(tools().list().length);
  });

  it("keeps ONE conversation across turns and every user message reaches the model", async () => {
    const seenUserTexts: string[] = [];
    const histories: number[] = [];
    const runner: ApiRunner = {
      async call(msgs) {
        histories.push(msgs.length);
        for (const m of msgs) if (m.role === "user" && typeof m.content === "string") seenUserTexts.push(m.content);
        return { content: `reply ${histories.length}`, toolCalls: [], finishReason: "stop" };
      },
    };
    const io = fakeIo(["what files are in src", "and how many tests", "/exit"]);
    const out = await runInteractiveApiSession({ adapter, tools: tools(), rendered, initialQuery: "start on the parser", runnerFactory: () => runner, io, info: baseInfo });
    expect(out.turns).toBe(3);
    // Each turn's user text is actually delivered (regression: follow-up input
    // was previously dropped and the model answered the prior turn).
    expect(seenUserTexts.some((t) => t.includes("what files are in src"))).toBe(true);
    expect(seenUserTexts.some((t) => t.includes("and how many tests"))).toBe(true);
    // History grows every turn — the conversation is preserved, not reset.
    expect(histories[1]!).toBeGreaterThan(histories[0]!);
    expect(histories[2]!).toBeGreaterThan(histories[1]!);
  });

  it("/status shows session + service + context; /help lists commands; /clear resets only the conversation", async () => {
    let callCount = 0;
    const runner: ApiRunner = { async call(msgs) { callCount += 1; return { content: `r${callCount} (history ${msgs.length})`, toolCalls: [], finishReason: "stop" }; } };
    const io = fakeIo(["/help", "/status", "one", "/clear", "two", "/exit"]);
    await runInteractiveApiSession({ adapter, tools: tools(), rendered, initialQuery: "go", runnerFactory: () => runner, io, info: baseInfo });
    expect(io.out).toContain("/exit");                 // /help
    expect(io.out).toContain("sess-1");                // /status session id
    expect(io.out).toContain("running-owned");         // /status service state
    expect(io.out).toContain("pid 4321");
    expect(io.out).toContain("Conversation cleared");  // /clear
  });

  it("/exit ends the session and the exit line says the local service is still running", async () => {
    const runner: ApiRunner = { async call() { return { content: "hi", toolCalls: [], finishReason: "stop" }; } };
    const io = fakeIo(["/exit"]);
    const out = await runInteractiveApiSession({ adapter, tools: tools(), rendered, initialQuery: "", runnerFactory: () => runner, io, info: baseInfo });
    expect(out.endedBy).toBe("exit");
    expect(io.out).toContain("Session ended");
    expect(io.out).toContain("service still running");
    expect(io.out).toContain("pid 4321");
    expect(io.out).toContain("continuum local stop");
  });

  it("EOF (Ctrl-D) ends the session cleanly", async () => {
    const runner: ApiRunner = { async call() { return { content: "hi", toolCalls: [], finishReason: "stop" }; } };
    const io = fakeIo([]); // readLine returns null immediately after turn 0
    const out = await runInteractiveApiSession({ adapter, tools: tools(), rendered, initialQuery: "hello", runnerFactory: () => runner, io, info: baseInfo });
    expect(out.endedBy).toBe("eof");
    expect(io.out).toContain("Session ended");
  });

  it("a per-turn telemetry footer is emitted", async () => {
    const runner: ApiRunner = {
      async call(_m, _t, opts) { opts?.onChunk?.("streamed answer"); return { content: "streamed answer", toolCalls: [], finishReason: "stop", usage: { promptTokens: 20, completionTokens: 12 }, timing: { requestMs: 500, ttftMs: 120, decodeMs: 200, streamed: true } }; },
    };
    const io = fakeIo(["/exit"]);
    await runInteractiveApiSession({ adapter, tools: tools(), rendered, initialQuery: "hi", runnerFactory: () => runner, io, info: baseInfo });
    expect(io.statuses.join(" ")).toMatch(/tok\/s/);
    expect(io.statuses.join(" ")).toMatch(/12 tok/);
  });

  it("captures each completed exchange out of band (memory capture)", async () => {
    const captured: Array<[string, string]> = [];
    const runner: ApiRunner = { async call() { return { content: "answer text", toolCalls: [], finishReason: "stop" }; } };
    const io = fakeIo(["a question", "/exit"]);
    await runInteractiveApiSession({
      adapter, tools: tools(), rendered, initialQuery: "start", runnerFactory: () => runner, io, info: baseInfo,
      onExchange: async (u, a) => { captured.push([u, a]); },
    });
    expect(captured).toContainEqual(["a question", "answer text"]);
  });
});
