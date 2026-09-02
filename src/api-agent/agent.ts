/**
 * The bounded API agent loop: model → (optional) tool request → MCP execution →
 * tool result → model, until the model produces a final answer (no tool calls)
 * or a bound is hit. Tool execution reuses the existing MCP `ToolRegistry` —
 * results are never invented, failures are surfaced, and there is no path to
 * arbitrary shell execution here (the registry owns what a tool may do).
 *
 * Three guards keep a run from spinning:
 *   1. First-turn tool withholding — when the session has no real task
 *      (blank / greeting), the first model turn is offered no tools, so a
 *      "hello" is answered directly instead of triggering repo exploration.
 *   2. Stall detection — a tool call (name + normalized arguments) that keeps
 *      producing a materially-equivalent result injects a concise stall
 *      signal telling the model to converge; repeated stalls end the run.
 *   3. `maxIterations` / `timeoutMs` — a final safety cap that returns a
 *      graceful partial answer (accumulated findings + the blocker), never a
 *      bare "loop exceeded N iterations".
 */

import { createHash } from "node:crypto";
import type { ToolRegistry } from "../mcp/tools.js";
import type { ApiRunner } from "./runner.js";
import {
  DEFAULT_AGENT_LIMITS,
  type AgentLoopLimits,
  type AgentMessage,
  type AgentStopReason,
} from "./types.js";
import type { OptimizedToolOutput } from "../tool-output/types.js";
import { ToolResultCache, computeCacheKey, type ToolScopeProvider } from "../tool-cache/tool-cache.js";
import type { ToolCacheScope } from "../mcp/tools.js";

export interface AgentLoopDeps {
  readonly runner: ApiRunner;
  readonly tools: ToolRegistry;
  readonly limits?: AgentLoopLimits;
  readonly now?: () => number;
  /** Where the final answer / each step is written (tests inject a no-op). */
  readonly onEvent?: (event: string, detail: string) => void;
  /** Optional Tool Output Optimizer; when absent, tool results pass through unchanged. */
  readonly optimizeOutput?: (toolName: string, text: string) => OptimizedToolOutput;
  /** Optional deterministic tool-result cache; when absent, no caching. */
  readonly cache?: ToolResultCache;
  /** Scope-fingerprint provider for the cache (project HEAD/dirty, session revision). */
  readonly scopeProvider?: ToolScopeProvider;
  /** Automatic continuity capture: called after each tool execution with a concise summary. */
  readonly onToolActivity?: (tool: string, summary: string) => void | Promise<void>;
  /**
   * The session's task intent. `absent` / `conversational` withhold tools on
   * the first model turn so a greeting or no-task session is answered
   * directly. `task` (default) is the normal agentic path.
   */
  readonly taskIntent?: "absent" | "conversational" | "task";
}

export interface AgentLoopResult {
  readonly finalContent: string | null;
  readonly iterations: number;
  readonly toolCalls: number;
  /** How the loop ended. Anything but `final` means the answer may be partial. */
  readonly stopReason: AgentStopReason;
}

interface CallRecord {
  count: number;
  lastResultHash: string;
  /** true once a stall signal has already been injected for this fingerprint. */
  warned: boolean;
}

function normalizeArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return JSON.stringify(sortDeep(parsed));
  } catch {
    return argsJson.trim();
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      out[key] = typeof v === "string" ? v.trim() : sortDeep(v);
    }
    return out;
  }
  return value;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

const STALL_SIGNAL =
  "STALL DETECTED: you have repeated the same action with equivalent arguments and gotten the same result, with no new information. Stop repeating it. Do exactly one of: " +
  "(a) answer the user now from the evidence you already have; " +
  "(b) take a materially different action (different file, different command, or a different approach); or " +
  "(c) state precisely what is blocking progress and what you need. Do not repeat a call you have already made.";

export async function runAgentLoop(messages: readonly AgentMessage[], deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const limits = deps.limits ?? DEFAULT_AGENT_LIMITS;
  const stallThreshold = limits.stallThreshold ?? DEFAULT_AGENT_LIMITS.stallThreshold ?? 3;
  const maxStallSignals = limits.maxStallSignals ?? DEFAULT_AGENT_LIMITS.maxStallSignals ?? 2;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const intent = deps.taskIntent ?? "task";

  const conversation: AgentMessage[] = [...messages];
  const seenCalls = new Map<string, CallRecord>();
  const activity: string[] = [];
  let toolCalls = 0;
  let iterations = 0;
  let stallSignals = 0;
  let lastAssistantText: string | null = null;

  const partial = (reason: AgentStopReason): AgentLoopResult => ({
    finalContent: buildPartialAnswer(reason, lastAssistantText, activity),
    iterations,
    toolCalls,
    stopReason: reason,
  });

  while (iterations < limits.maxIterations) {
    if (now() - started > limits.timeoutMs) return partial("timeout");
    iterations += 1;

    // First turn with no real task → offer no tools so a greeting is answered
    // directly rather than triggering autonomous exploration.
    const withholdTools = iterations === 1 && intent !== "task";
    const turn = await deps.runner.call(conversation, withholdTools ? [] : deps.tools.list());
    conversation.push({ role: "assistant", content: turn.content, ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}) });
    if (turn.content) lastAssistantText = turn.content;

    if (turn.toolCalls.length === 0) {
      return { finalContent: turn.content, iterations, toolCalls, stopReason: "final" };
    }

    let stalledThisTurn = false;
    for (const tc of turn.toolCalls) {
      toolCalls += 1;
      const finalText = await resolveToolText(deps, tc.name, tc.arguments);
      conversation.push({ role: "tool", toolCallId: tc.id, content: finalText });
      deps.onEvent?.("tool", `${tc.name} → ${finalText.slice(0, 120)}`);
      const isError = finalText.startsWith("[tool error]") || finalText.startsWith("[tool failure]");
      const summary = summarizeToolCall(tc.name, tc.arguments, isError);
      activity.push(summary);
      await deps.onToolActivity?.(tc.name, summary);

      const fp = `${tc.name}|${normalizeArgs(tc.arguments)}`;
      const resultHash = hash(finalText);
      const rec = seenCalls.get(fp);
      if (rec) {
        rec.count += 1;
        const equivalent = rec.lastResultHash === resultHash;
        rec.lastResultHash = resultHash;
        // A repeat with the SAME result is a hard stall at the threshold; a
        // repeat with a changing result is given more rope (threshold + 2).
        if ((equivalent && rec.count >= stallThreshold) || rec.count >= stallThreshold + 2) {
          stalledThisTurn = true;
        }
      } else {
        seenCalls.set(fp, { count: 1, lastResultHash: resultHash, warned: false });
      }
    }

    if (stalledThisTurn) {
      if (stallSignals >= maxStallSignals) return partial("stalled");
      conversation.push({ role: "user", content: STALL_SIGNAL });
      stallSignals += 1;
      deps.onEvent?.("stall", `injected stall signal ${stallSignals}/${maxStallSignals}`);
      // Give the model a fresh window: repeated fingerprints must re-cross the
      // threshold from a lower count, not trip again on the next identical call.
      for (const rec of seenCalls.values()) rec.count = Math.max(0, stallThreshold - 2);
    }
  }

  return partial("max-iterations");
}

/** Build a graceful partial answer: last assistant text + accumulated findings + the blocker. */
function buildPartialAnswer(reason: AgentStopReason, lastAssistantText: string | null, activity: readonly string[]): string {
  const blocker =
    reason === "stalled"
      ? "the agent kept repeating the same action without making progress"
      : reason === "timeout"
        ? "the agent reached its time limit"
        : "the agent reached its iteration limit";

  const findings = dedupeKeepOrder(activity);
  const lines: string[] = [];
  if (lastAssistantText && lastAssistantText.trim()) lines.push(lastAssistantText.trim(), "");
  lines.push(`⚠️ The agent stopped before finishing — ${blocker}.`);
  if (findings.length > 0) {
    lines.push("", "Progress so far:");
    for (const f of findings.slice(0, 20)) lines.push(`  - ${f}`);
    if (findings.length > 20) lines.push(`  - …and ${findings.length - 20} more steps`);
  }
  lines.push("", "Re-run with a specific task (`--task \"…\"`) so the agent has a concrete goal to converge on.");
  return lines.join("\n");
}

function dedupeKeepOrder(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

/** Cache-aware tool resolution: check cache (fail-safe), else execute + optimize + store. */
async function resolveToolText(deps: AgentLoopDeps, name: string, argsJson: string): Promise<string> {
  const scope = deps.tools.definition(name)?.cacheScope;
  if (deps.cache && scope && deps.scopeProvider) {
    const fingerprint = await scopeFingerprint(scope, argsJson, deps.scopeProvider);
    const key = computeCacheKey(name, argsJson, scope, fingerprint);
    if (key !== undefined) {
      const hit = deps.cache.get(key);
      if (hit !== undefined) {
        deps.cache.telemetry.hits += 1;
        deps.cache.telemetry.tokensAvoided += deps.cache.tokensSavedForKey(key);
        deps.onEvent?.("cache", `hit ${name}`);
        return hit;
      }
      deps.cache.telemetry.misses += 1;
      const raw = await executeTool(deps.tools, name, argsJson);
      const optimized = deps.optimizeOutput ? deps.optimizeOutput(name, raw) : plain(raw);
      const finalText = optimized.rawRef ? `${optimized.text}\n[raw output retained: ${optimized.rawRef}]` : optimized.text;
      deps.cache.set(key, finalText, optimized.telemetry.tokensSaved);
      deps.onEvent?.("cache", `miss ${name}`);
      return finalText;
    }
  }
  // Uncached path (unchanged).
  const raw = await executeTool(deps.tools, name, argsJson);
  return applyOutputOptimizer(name, raw, deps.optimizeOutput, deps.onEvent);
}

function plain(text: string): OptimizedToolOutput {
  return { text, telemetry: { originalBytes: 0, optimizedBytes: 0, originalTokens: 0, optimizedTokens: 0, tokensSaved: 0, percentSaved: 0, optimizer: "passthrough", rawRetained: false } };
}

async function scopeFingerprint(scope: ToolCacheScope, argsJson: string, provider: ToolScopeProvider): Promise<string | undefined> {
  if (scope === "global") return "global";
  if (scope === "project") return provider.projectFingerprint ? await provider.projectFingerprint() : undefined;
  if (scope === "session") {
    let sid: string | undefined;
    try {
      const a = JSON.parse(argsJson) as Record<string, unknown>;
      sid = typeof a.sessionId === "string" ? a.sessionId : undefined;
    } catch {
      sid = undefined;
    }
    if (!sid || !provider.sessionFingerprint) return undefined;
    return await provider.sessionFingerprint(sid);
  }
  return undefined;
}

async function executeTool(tools: ToolRegistry, name: string, argsJson: string): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: `tool "${name}": invalid JSON arguments` });
  }
  try {
    const result = await tools.call(name, args);
    const text = result.content.map((c) => c.text).join("\n");
    return result.isError ? `[tool error] ${text}` : text;
  } catch (err) {
    // Unknown tool or handler throw → surface, never fabricate.
    return `[tool failure] ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** A concise, secret-free summary of a tool execution for continuity capture. */
export function summarizeToolCall(tool: string, argsJson: string, isError: boolean): string {
  let target = "";
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    for (const key of ["path", "file", "filePath", "project", "op", "sessionId", "query", "name", "id", "command"]) {
      const v = a[key];
      if (typeof v === "string" && v.trim()) {
        target = v.trim();
        break;
      }
    }
  } catch {
    // malformed args → no target
  }
  const status = isError ? " (error)" : "";
  const trimmed = target.length > 80 ? `${target.slice(0, 77)}…` : target;
  return trimmed ? `${tool} ${trimmed}${status}` : `${tool}${status}`;
}

/** Apply the optimizer if configured; append a retrievable raw reference when retained. */
function applyOutputOptimizer(
  toolName: string,
  text: string,
  optimizeOutput: ((toolName: string, text: string) => OptimizedToolOutput) | undefined,
  onEvent: ((event: string, detail: string) => void) | undefined,
): string {
  if (!optimizeOutput) return text;
  const optimized = optimizeOutput(toolName, text);
  onEvent?.("optimize", `${toolName}: ${optimized.telemetry.optimizer} ${optimized.telemetry.originalTokens}→${optimized.telemetry.optimizedTokens} tok`);
  return optimized.rawRef ? `${optimized.text}\n[raw output retained: ${optimized.rawRef}]` : optimized.text;
}
