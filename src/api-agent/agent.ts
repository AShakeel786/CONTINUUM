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

export interface AgentLoopDeps {
  readonly runner: ApiRunner;
  readonly tools: ToolRegistry;
  readonly limits?: AgentLoopLimits;
  readonly now?: () => number;
  /** Where the final answer / each step is written (tests inject a no-op). */
  readonly onEvent?: (event: string, detail: string) => void;
  /** Optional Tool Output Optimizer; when absent, tool results pass through unchanged. */
  readonly optimizeOutput?: (toolName: string, text: string) => OptimizedToolOutput;
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
      const resultText = await executeTool(deps.tools, tc.name, tc.arguments);
      const finalText = applyOutputOptimizer(tc.name, resultText, deps.optimizeOutput, deps.onEvent);
      conversation.push({ role: "tool", toolCallId: tc.id, content: finalText });
      deps.onEvent?.("tool", `${tc.name} → ${finalText.slice(0, 120)}`);
    }
  }

  throw new AgentLoopError("max-iterations", `agent loop exceeded ${limits.maxIterations} iterations`);
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
