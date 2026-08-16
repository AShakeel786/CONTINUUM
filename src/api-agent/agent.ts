/**
 * The bounded API agent loop: model → (optional) tool request → MCP execution →
 * tool result → model, until the model produces a final answer (no tool calls)
 * or the iteration/timeout bound is hit. Tool execution reuses the existing
 * MCP `ToolRegistry` — results are never invented, failures are surfaced, and
 * there is no path to arbitrary shell execution here (the registry owns what
 * a tool may do, exactly as in the MCP server).
 */

import type { ToolRegistry } from "../mcp/tools.js";
import type { ApiRunner } from "./runner.js";
import { AgentLoopError, DEFAULT_AGENT_LIMITS, type AgentLoopLimits, type AgentMessage, type AgentTurnResult } from "./types.js";
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
}

export interface AgentLoopResult {
  readonly finalContent: string | null;
  readonly iterations: number;
  readonly toolCalls: number;
}

export async function runAgentLoop(messages: readonly AgentMessage[], deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const limits = deps.limits ?? DEFAULT_AGENT_LIMITS;
  const now = deps.now ?? (() => Date.now());
  const started = now();

  const conversation: AgentMessage[] = [...messages];
  let toolCalls = 0;
  let iterations = 0;

  while (iterations < limits.maxIterations) {
    if (now() - started > limits.timeoutMs) {
      throw new AgentLoopError("timeout", `agent loop exceeded ${limits.timeoutMs}ms`);
    }
    iterations += 1;

    const turn = await deps.runner.call(conversation, deps.tools.list());
    conversation.push({ role: "assistant", content: turn.content, ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}) });

    if (turn.toolCalls.length === 0) {
      return { finalContent: turn.content, iterations, toolCalls };
    }

    // Execute each tool call through the MCP registry; never invent results.
    for (const tc of turn.toolCalls) {
      toolCalls += 1;
      const finalText = await resolveToolText(deps, tc.name, tc.arguments);
      conversation.push({ role: "tool", toolCallId: tc.id, content: finalText });
      deps.onEvent?.("tool", `${tc.name} → ${finalText.slice(0, 120)}`);
    }
  }

  throw new AgentLoopError("max-iterations", `agent loop exceeded ${limits.maxIterations} iterations`);
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
