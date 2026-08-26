import { describe, expect, it, vi } from "vitest";
import { createProviderAdapter } from "../../providers/adapter.js";
import { manifestToProfile, type ProviderManifest } from "../../providers/manifest.js";
import { geminiFreeManifest, groqFreeManifest, openRouterFreeManifest } from "../../providers/presets.js";
import { ToolRegistry, textResult } from "../../mcp/tools.js";
import { runAgentLoop } from "../agent.js";
import { ApiFailoverExhaustedError, createFailoverApiRunner, type FailoverCandidate } from "../failover.js";
import type { ApiRunner } from "../runner.js";
import { ApiAgentError, type AgentMessage, type AgentTurnResult, type NetworkFailureKind } from "../types.js";

const initial: AgentMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "ship it" }];
const success: AgentTurnResult = { content: "done", toolCalls: [], finishReason: "stop" };

function adapter(id: string, billing: "free" | "paid" = "free") {
  const manifest: ProviderManifest = {
    schemaVersion: 1,
    id,
    displayName: id.toUpperCase(),
    protocol: "openai-compatible",
    baseUrl: `https://${id}.example/v1`,
    auth: { kind: "bearer-token", envVar: `${id.toUpperCase()}_KEY` },
    models: { default: `${id}-model` },
    capabilities: { tools: true },
    billing,
  };
  return createProviderAdapter(manifestToProfile(manifest));
}

function candidate(id: string, runner: ApiRunner, billing: "free" | "paid" = "free", disabledReason?: string): FailoverCandidate {
  return { adapter: adapter(id, billing), env: {}, runner, billing, ...(disabledReason ? { disabledReason } : {}) };
}

function manifestCandidate(manifest: ProviderManifest, runner: ApiRunner, disabledReason?: string): FailoverCandidate {
  return {
    adapter: createProviderAdapter(manifestToProfile(manifest)),
    env: {},
    runner,
    billing: manifest.billing ?? "paid",
    ...(disabledReason ? { disabledReason } : {}),
  };
}

function failing(kind: NetworkFailureKind, retryAtMs?: number): ApiRunner {
  return {
    call: vi.fn(async () => {
      throw new ApiAgentError(`${kind}`, { kind, retryable: true, ...(retryAtMs !== undefined ? { retryAtMs } : {}) });
    }),
  };
}

function succeeding(onCall?: (messages: readonly AgentMessage[]) => void): ApiRunner {
  return { call: vi.fn(async (messages) => { onCall?.(messages); return success; }) };
}

describe("same-session API failover", () => {
  it("Gemini 429 → Groq continues the identical logical call", async () => {
    const histories: AgentMessage[][] = [];
    const gemini: ApiRunner = {
      call: vi.fn(async (messages) => {
        histories.push([...messages]);
        throw new ApiAgentError("limited", { kind: "rate-limit", retryable: true });
      }),
    };
    const groq = succeeding((messages) => histories.push([...messages]));
    const runner = createFailoverApiRunner([
      manifestCandidate(geminiFreeManifest, gemini),
      manifestCandidate(groqFreeManifest, groq),
    ]);

    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(histories).toEqual([initial, initial]);
    expect(runner.activeProviderId()).toBe("groq-free");
  });

  it("Groq exhausted → OpenRouter continues the identical logical call", async () => {
    const histories: AgentMessage[][] = [];
    const groq: ApiRunner = {
      call: vi.fn(async (messages) => {
        histories.push([...messages]);
        throw new ApiAgentError("quota", { kind: "quota-exhausted", retryable: false });
      }),
    };
    const openRouter = succeeding((messages) => histories.push([...messages]));
    const runner = createFailoverApiRunner([
      manifestCandidate(groqFreeManifest, groq),
      manifestCandidate(openRouterFreeManifest, openRouter),
    ]);

    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(histories).toEqual([initial, initial]);
    expect(runner.activeProviderId()).toBe("openrouter-free");
  });

  it("Gemini → Groq → OpenRouter cascades with one unchanged message history", async () => {
    const histories: AgentMessage[][] = [];
    const fail = (kind: NetworkFailureKind): ApiRunner => ({
      call: vi.fn(async (messages) => {
        histories.push([...messages]);
        throw new ApiAgentError(kind, { kind, retryable: kind !== "quota-exhausted" });
      }),
    });
    const openRouter = succeeding((messages) => histories.push([...messages]));
    const runner = createFailoverApiRunner([
      manifestCandidate(geminiFreeManifest, fail("rate-limit")),
      manifestCandidate(groqFreeManifest, fail("quota-exhausted")),
      manifestCandidate(openRouterFreeManifest, openRouter),
    ]);

    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(histories).toEqual([initial, initial, initial]);
    expect(runner.activeProviderId()).toBe("openrouter-free");
  });

  it("skips a missing-key candidate without ending the session", async () => {
    const unavailable = succeeding();
    const groq = succeeding();
    const runner = createFailoverApiRunner([
      manifestCandidate(geminiFreeManifest, unavailable, "API credential unavailable"),
      manifestCandidate(groqFreeManifest, groq),
    ]);

    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(unavailable.call).not.toHaveBeenCalled();
    expect(groq.call).toHaveBeenCalledTimes(1);
  });

  it("429 A → B succeeds with the identical message history", async () => {
    const seen: AgentMessage[][] = [];
    const a: ApiRunner = { call: vi.fn(async (messages) => { seen.push([...messages]); throw new ApiAgentError("429", { kind: "rate-limit", retryable: true }); }) };
    const b = succeeding((messages) => seen.push([...messages]));
    const runner = createFailoverApiRunner([candidate("a", a), candidate("b", b)]);

    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(seen).toEqual([initial, initial]);
  });

  it("cascades A → B → C across the full eligible chain", async () => {
    const switches: string[] = [];
    const runner = createFailoverApiRunner(
      [candidate("a", failing("server-error")), candidate("b", failing("timeout")), candidate("c", succeeding())],
      { onSwitch: (event) => { switches.push(`${event.fromProviderId}->${event.toProviderId}`); } },
    );

    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(switches).toEqual(["a->b", "b->c"]);
    expect(runner.activeProviderId()).toBe("c");
  });

  it("preserves one assistant tool-call and one tool result when the next model provider dies", async () => {
    const toolTurn: AgentTurnResult = {
      content: null,
      toolCalls: [{ id: "tool-1", name: "write_once", arguments: "{\"value\":1}" }],
      finishReason: "tool_calls",
    };
    let aCalls = 0;
    const a: ApiRunner = {
      call: vi.fn(async () => {
        aCalls += 1;
        if (aCalls === 1) return toolTurn;
        throw new ApiAgentError("outage", { kind: "server-error", retryable: true });
      }),
    };
    let replacementMessages: readonly AgentMessage[] = [];
    const b = succeeding((messages) => { replacementMessages = [...messages]; });
    const runner = createFailoverApiRunner([candidate("a", a), candidate("b", b)]);
    const tools = new ToolRegistry();
    let executions = 0;
    tools.register({
      definition: { name: "write_once", description: "writes once", inputSchema: { type: "object" }, access: "write" },
      handler: async () => { executions += 1; return textResult("written"); },
    });

    const result = await runAgentLoop(initial, { runner, tools });

    expect(result.finalContent).toBe("done");
    expect(executions).toBe(1);
    expect(replacementMessages).toEqual([
      ...initial,
      { role: "assistant", content: null, toolCalls: toolTurn.toolCalls },
      { role: "tool", toolCallId: "tool-1", content: "written" },
    ]);
  });

  it("a failed model provider never causes duplicate tool execution", async () => {
    const calls = vi.fn(async () => textResult("once"));
    const tools = new ToolRegistry();
    tools.register({ definition: { name: "once", description: "once", inputSchema: {}, access: "write" }, handler: calls });
    let first = true;
    const a: ApiRunner = { call: async () => {
      if (first) { first = false; return { content: null, toolCalls: [{ id: "x", name: "once", arguments: "{}" }], finishReason: "tool_calls" }; }
      throw new ApiAgentError("down", { kind: "dns", retryable: true });
    } };
    await runAgentLoop(initial, { runner: createFailoverApiRunner([candidate("a", a), candidate("b", succeeding())]), tools });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("Retry-After cooldown prevents immediate reselection", async () => {
    let now = 1_000;
    let calls = 0;
    const a: ApiRunner = { call: async () => {
      calls += 1;
      if (calls === 1) throw new ApiAgentError("limited", { kind: "rate-limit", retryable: true, retryAtMs: 5_000 });
      return success;
    } };
    const runner = createFailoverApiRunner([candidate("a", a)], { now: () => now });
    await expect(runner.call(initial, [])).rejects.toBeInstanceOf(ApiFailoverExhaustedError);
    await expect(runner.call(initial, [])).rejects.toBeInstanceOf(ApiFailoverExhaustedError);
    expect(calls).toBe(1);
    now = 5_000;
    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(calls).toBe(2);
  });

  it("freeOnly never reaches a paid provider", async () => {
    const paid = succeeding();
    const runner = createFailoverApiRunner([candidate("free", failing("quota-exhausted")), candidate("paid", paid, "paid")], {
      mode: "freeOnly",
      allowPaidFallback: true,
    });
    await expect(runner.call(initial, [])).rejects.toBeInstanceOf(ApiFailoverExhaustedError);
    expect(paid.call).not.toHaveBeenCalled();
  });

  it("freeFirst reaches paid only with explicit opt-in", async () => {
    const paidOff = succeeding();
    const withoutOptIn = createFailoverApiRunner([candidate("free", failing("quota-exhausted")), candidate("paid", paidOff, "paid")], { mode: "freeFirst" });
    await expect(withoutOptIn.call(initial, [])).rejects.toBeInstanceOf(ApiFailoverExhaustedError);
    expect(paidOff.call).not.toHaveBeenCalled();

    const paidOn = succeeding();
    const withOptIn = createFailoverApiRunner([candidate("free2", failing("quota-exhausted")), candidate("paid2", paidOn, "paid")], {
      mode: "freeFirst",
      allowPaidFallback: true,
    });
    await expect(withOptIn.call(initial, [])).resolves.toEqual(success);
    expect(paidOn.call).toHaveBeenCalledTimes(1);
  });

  it("disables an auth-failed candidate and skips it thereafter", async () => {
    const disabled = failing("auth");
    const enabled = succeeding();
    const runner = createFailoverApiRunner([candidate("a", disabled), candidate("b", enabled)]);
    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(disabled.call).toHaveBeenCalledTimes(1);
    expect(enabled.call).toHaveBeenCalledTimes(1);
    await expect(runner.call(initial, [])).resolves.toEqual(success);
    expect(disabled.call).toHaveBeenCalledTimes(1);
    expect(runner.status()[0]).toMatchObject({ health: "disabled", failureReason: "authentication failed" });
  });

  it("fails malformed/config 4xx instead of cycling the pool", async () => {
    const bad = failing("http-error");
    const fallback = succeeding();
    const runner = createFailoverApiRunner([candidate("a", bad), candidate("b", fallback)]);
    await expect(runner.call(initial, [])).rejects.toMatchObject({ kind: "http-error" });
    expect(fallback.call).not.toHaveBeenCalled();
  });

  it("returns a deterministic, credential-free exhaustion summary", async () => {
    const runner = createFailoverApiRunner([
      candidate("a", failing("quota-exhausted")),
      candidate("b", succeeding(), "free", "API credential unavailable"),
      candidate("c", succeeding(), "paid"),
    ]);
    const error = await runner.call(initial, []).catch((caught: unknown) => caught) as ApiFailoverExhaustedError;
    expect(error.message).toBe("API provider pool exhausted — A: exhausted (quota exhausted); B: disabled (API credential unavailable); C: disabled (paid fallback not enabled). Configure another free API provider or explicitly enable paid fallback.");
    expect(error.message).not.toContain("KEY");
  });
});
