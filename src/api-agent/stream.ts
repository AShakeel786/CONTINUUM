/**
 * OpenAI-compatible Server-Sent-Events parsing for streaming chat completions.
 * Provider-agnostic: any provider whose endpoint speaks the OpenAI
 * `data: {json}` streaming frame (mlx_lm.server, vLLM, llama.cpp, …) works.
 *
 * We only stream text deltas incrementally; tool-call deltas are accumulated
 * and surfaced once at end-of-stream so the existing tool-execution path is
 * unchanged. A provider that does not support streaming falls back to the
 * non-streaming call at the runner level — nothing here fabricates a stream.
 */

import type { AgentToolCall, AgentTurnResult } from "./types.js";

export type StreamFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText: string; chunks: AsyncIterable<string> }>;

/** Default streaming fetch over the platform `fetch` + a UTF-8 decoded body reader. */
export function defaultStreamFetch(timeoutMs: number): StreamFetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const outerSignal = init.signal;
    if (outerSignal) outerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
    async function* chunks(): AsyncIterable<string> {
      try {
        const body = res.body;
        if (!body) return;
        const decoder = new TextDecoder();
        const iterable = body as unknown as AsyncIterable<Uint8Array>;
        for await (const part of iterable) {
          yield decoder.decode(part, { stream: true });
        }
        yield decoder.decode();
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: res.ok, status: res.status, statusText: res.statusText, chunks: chunks() };
  };
}

interface StreamAccumulator {
  text: string;
  firstTokenAt?: number;
  lastTokenAt?: number;
  finishReason: string;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * Consume an OpenAI-style SSE stream. `onText` fires for every non-empty text
 * delta with `now()` supplied for first-token timing. Returns the fully
 * assembled turn plus timing.
 */
export async function consumeOpenAiStream(
  chunks: AsyncIterable<string>,
  opts: { onText: (delta: string) => void; now: () => number; sourceProviderId: string },
): Promise<{ result: AgentTurnResult; firstTokenAt?: number; lastTokenAt?: number }> {
  const acc: StreamAccumulator = { text: "", finishReason: "stop", toolCalls: new Map() };
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json: {
        choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) {
        acc.usage = { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens };
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) acc.finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        const now = opts.now();
        if (acc.firstTokenAt === undefined) acc.firstTokenAt = now;
        acc.lastTokenAt = now;
        acc.text += delta.content;
        opts.onText(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const cur = acc.toolCalls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        acc.toolCalls.set(tc.index, cur);
      }
    }
  }

  const toolCalls: AgentToolCall[] = [...acc.toolCalls.values()]
    .filter((t) => t.id && t.name)
    .map((t) => ({ id: t.id, name: t.name, arguments: t.arguments || "{}" }));

  const result: AgentTurnResult = {
    content: acc.text.length ? acc.text : null,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : acc.finishReason,
    ...(acc.usage ? { usage: acc.usage } : {}),
  };
  return {
    result,
    ...(acc.firstTokenAt !== undefined ? { firstTokenAt: acc.firstTokenAt } : {}),
    ...(acc.lastTokenAt !== undefined ? { lastTokenAt: acc.lastTokenAt } : {}),
  };
}
