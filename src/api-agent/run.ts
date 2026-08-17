/**
 * Top-level "run an API provider as a CONTINUUM agent" entry point. Builds the
 * first-turn messages from the already-budgeted + rendered context, runs the
 * bounded tool loop, and returns the final answer. No provider-id branch; the
 * runner selects the protocol from capabilities.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { RenderedContext } from "../rendering/types.js";
import type { ToolRegistry } from "../mcp/tools.js";
import { createApiRunner, type FetchLike } from "./runner.js";
import { runAgentLoop } from "./agent.js";
import { optimizeToolOutput } from "../tool-output/optimizer.js";
import type { OptimizedToolOutput } from "../tool-output/types.js";
import type { ToolResultCache, ToolScopeProvider } from "../tool-cache/tool-cache.js";
import type { AgentLoopLimits, AgentMessage, NetworkFailureKind } from "./types.js";

export interface RunApiAgentDeps {
  readonly adapter: ProviderAdapter;
  readonly tools: ToolRegistry;
  readonly rendered: RenderedContext;
  readonly query: string;
  readonly limits?: AgentLoopLimits;
  readonly onOutput?: (line: string) => void;
  /** Injectable fetch (tests/mocks); defaults to real fetch. */
  readonly fetch?: FetchLike;
  /** Injectable retry sleep (tests); defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Bounded retry ceiling for transient network failures; default 4. */
  readonly maxAttempts?: number;
  /** Tool Output Optimizer; default applies the deterministic optimizer. Pass a no-op to disable. */
  readonly optimizeOutput?: (toolName: string, text: string) => OptimizedToolOutput;
  /** Deterministic tool-result cache; when absent, no caching. */
  readonly cache?: ToolResultCache;
  /** Scope-fingerprint provider for the cache. */
  readonly scopeProvider?: ToolScopeProvider;
  /** Automatic session continuity capture (tool → concise summary), after each tool execution. */
  readonly recordToolActivity?: (tool: string, summary: string) => Promise<void>;
}

export interface RunApiAgentResult {
  readonly finalContent: string | null;
  readonly iterations: number;
  readonly toolCalls: number;
}

function systemToString(system: RenderedContext["system"]): string {
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

/** Short, stateful reason text for the retry progress line — never the raw error/body. */
function retryReason(kind: NetworkFailureKind): string {
  switch (kind) {
    case "dns":
      return "could not be resolved";
    case "connection-refused":
      return "refused the connection";
    case "timeout":
      return "timed out";
    case "rate-limit":
      return "rate-limited the request";
    case "server-error":
      return "returned a server error";
    default:
      return "unreachable";
  }
}

/** Build the initial messages from the rendered context + task query. */
export function buildInitialMessages(rendered: RenderedContext, query: string): readonly AgentMessage[] {
  const system = systemToString(rendered.system);
  const user = rendered.userPrefix ? `${rendered.userPrefix}\n\n${query}` : query;
  const messages: AgentMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  return messages;
}

export async function runApiAgent(deps: RunApiAgentDeps): Promise<RunApiAgentResult> {
  const messages = buildInitialMessages(deps.rendered, deps.query);
  const runner = createApiRunner(deps.adapter, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    onRetry: (info) => {
      const delayS = (info.delayMs / 1000).toFixed(1);
      deps.onOutput?.(`${deps.adapter.profile.displayName} API connection failed — ${info.host} ${retryReason(info.kind)}. Retry ${info.attempt}/${info.maxAttempts} in ${delayS}s.\n`);
    },
  });
  const optimizeOutput = deps.optimizeOutput ?? ((toolName: string, text: string) => optimizeToolOutput(toolName, text));
  const result = await runAgentLoop(messages, {
    runner,
    tools: deps.tools,
    limits: deps.limits,
    optimizeOutput,
    cache: deps.cache,
    scopeProvider: deps.scopeProvider,
    onEvent: (event, detail) => deps.onOutput?.(`[${event}] ${detail}\n`),
    onToolActivity: deps.recordToolActivity ? (tool, summary) => deps.recordToolActivity!(tool, summary) : undefined,
  });
  return { finalContent: result.finalContent, iterations: result.iterations, toolCalls: result.toolCalls };
}
