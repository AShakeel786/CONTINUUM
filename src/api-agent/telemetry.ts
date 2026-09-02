/**
 * Render measured per-response telemetry. Nothing is fabricated: a field the
 * backend did not make measurable is simply omitted. `decodeTokPerSec` is
 * model-decode only (see `TurnTelemetry`), never total wall-clock.
 */

import type { TurnTelemetry } from "./types.js";

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** `✓ Done · 286 tok · 91.4 tok/s · TTFT 0.38s · ctx 3.8k/131k` — omits any unmeasured part. */
export function formatTelemetryFooter(t: TurnTelemetry, opts: { done?: boolean; partial?: boolean } = {}): string {
  const parts: string[] = [];
  const lead = opts.partial ? "· partial" : opts.done === false ? "" : "✓ Done";
  if (lead) parts.push(lead);
  if (t.outputTokens !== undefined) parts.push(`${t.outputTokens} tok${t.tokenSource === "estimate" ? "~" : ""}`);
  if (t.decodeTokPerSec !== undefined) parts.push(`${t.decodeTokPerSec} tok/s`);
  if (t.ttftMs !== undefined) parts.push(`TTFT ${(t.ttftMs / 1000).toFixed(2)}s`);
  if (t.decodeMs !== undefined && t.decodeTokPerSec === undefined) parts.push(`decode ${(t.decodeMs / 1000).toFixed(1)}s`);
  if (t.contextTokens !== undefined) {
    parts.push(t.contextLimit ? `ctx ${k(t.contextTokens)}/${k(t.contextLimit)}` : `ctx ${k(t.contextTokens)}`);
  }
  if (!t.streamed && t.ttftMs === undefined && t.requestMs !== undefined) parts.push(`req ${(t.requestMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

/** A one-line telemetry summary for a non-interactive run's stderr note. */
export function telemetryOneLine(t: TurnTelemetry): string {
  const f = formatTelemetryFooter(t, { done: false });
  return f || "no telemetry available";
}
