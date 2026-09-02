import { describe, expect, it, vi } from "vitest";
import { consumeOpenAiStream } from "../stream.js";
import { createApiRunner } from "../runner.js";
import { formatTelemetryFooter } from "../telemetry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { localOrnith15Manifest } from "../../providers/presets.js";
import type { StreamFetchLike } from "../stream.js";

const adapter = createProviderAdapter(manifestToProfile(localOrnith15Manifest));

async function* sse(lines: string[]): AsyncIterable<string> {
  for (const l of lines) yield l;
}

function streamFrames(deltas: string[], usage?: { prompt_tokens: number; completion_tokens: number }): string[] {
  const frames = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n`);
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) })}\n`);
  frames.push("data: [DONE]\n");
  return frames;
}

describe("consumeOpenAiStream", () => {
  it("assembles text deltas and records first/last token timing", async () => {
    let t = 1000;
    const chunks: string[] = [];
    const { result, firstTokenAt, lastTokenAt } = await consumeOpenAiStream(sse(streamFrames(["Hel", "lo ", "world"], { prompt_tokens: 5, completion_tokens: 3 })), {
      onText: (d) => chunks.push(d),
      now: () => (t += 100),
      sourceProviderId: "local-ornith15",
    });
    expect(chunks).toEqual(["Hel", "lo ", "world"]);
    expect(result.content).toBe("Hello world");
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
    expect(firstTokenAt).toBeLessThan(lastTokenAt!);
  });

  it("accumulates a streamed tool call and surfaces it at end of stream", async () => {
    const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n`;
    const frames = [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_" } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '{"path":' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n",
    ];
    const { result } = await consumeOpenAiStream(sse(frames), { onText: () => {}, now: () => 1, sourceProviderId: "x" });
    expect(result.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }]);
    expect(result.finishReason).toBe("tool_calls");
  });
});

describe("createApiRunner streaming", () => {
  it("streams text incrementally and returns timing", async () => {
    const streamFetch: StreamFetchLike = async () => ({
      ok: true, status: 200, statusText: "OK",
      chunks: sse(streamFrames(["one ", "two ", "three"], { prompt_tokens: 10, completion_tokens: 3 })),
    });
    const runner = createApiRunner(adapter, { streamFetch });
    const seen: string[] = [];
    const turn = await runner.call([{ role: "user", content: "hi" }], [], { onChunk: (d) => seen.push(d) });
    expect(seen).toEqual(["one ", "two ", "three"]);
    expect(turn.content).toBe("one two three");
    expect(turn.timing?.streamed).toBe(true);
    expect(turn.timing?.requestMs).toBeGreaterThanOrEqual(0);
    expect(turn.usage?.completionTokens).toBe(3);
  });

  it("falls back to non-streaming and still emits the whole answer as one chunk", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: "full answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) }));
    const streamFetch: StreamFetchLike = async () => { throw new Error("stream unsupported"); };
    const runner = createApiRunner(adapter, { fetch: fetchImpl, streamFetch });
    const seen: string[] = [];
    const turn = await runner.call([{ role: "user", content: "hi" }], [], { onChunk: (d) => seen.push(d) });
    expect(seen).toEqual(["full answer"]);
    expect(turn.content).toBe("full answer");
    expect(turn.timing?.streamed).toBe(false);
  });

  it("passes maxOutputTokens through as wire max_tokens (non-stream)", async () => {
    let sentBody: any;
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: "x" } }] }) }; });
    const runner = createApiRunner(adapter, { fetch: fetchImpl });
    await runner.call([{ role: "user", content: "hi" }], [], { maxOutputTokens: 555 });
    expect(sentBody.max_tokens).toBe(555);
  });
});

describe("formatTelemetryFooter", () => {
  it("renders known metrics and omits the rest — never fabricates", () => {
    const f = formatTelemetryFooter({ outputTokens: 286, decodeTokPerSec: 91.4, ttftMs: 380, contextTokens: 3800, contextLimit: 131072, tokenSource: "provider-usage", streamed: true });
    expect(f).toContain("286 tok");
    expect(f).toContain("91.4 tok/s");
    expect(f).toContain("TTFT 0.38s");
    expect(f).toContain("ctx 3.8k/131k");
    expect(f).not.toContain("undefined");
    expect(f).not.toContain("NaN");
  });

  it("a non-streamed turn shows request time, not a fake decode rate", () => {
    const f = formatTelemetryFooter({ outputTokens: 40, requestMs: 2200, contextTokens: 900, tokenSource: "estimate", streamed: false });
    expect(f).toContain("40 tok~"); // ~ marks an estimate
    expect(f).not.toContain("tok/s"); // no decode rate without streaming timestamps
    expect(f).toContain("req 2.2s");
  });

  it("omits everything gracefully when nothing was measured", () => {
    expect(formatTelemetryFooter({}, { done: false })).toBe("");
  });
});
