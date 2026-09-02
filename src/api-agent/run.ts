/**
 * Top-level "run an API provider as a CONTINUUM agent" entry point. Builds the
 * first-turn messages from the already-budgeted + rendered context, runs the
 * bounded tool loop, and returns the final answer. No provider-id branch; the
 * runner selects the protocol from capabilities.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { RenderedContext } from "../rendering/types.js";
import type { ToolRegistry } from "../mcp/tools.js";
import { createApiRunner, type ApiRunner, type FetchLike } from "./runner.js";
import { runAgentLoop } from "./agent.js";
import { optimizeToolOutput } from "../tool-output/optimizer.js";
import { defaultRawStore, type RawOutputStore } from "../tool-output/store.js";
import { DEFAULT_OPTIMIZE_OPTIONS } from "../tool-output/types.js";
import type { OptimizedToolOutput } from "../tool-output/types.js";
import type { ToolResultCache, ToolScopeProvider } from "../tool-cache/tool-cache.js";
import type { AgentLoopLimits, AgentMessage, AgentStopReason, NetworkFailureKind } from "./types.js";

export interface RunApiAgentDeps {
  readonly adapter: ProviderAdapter;
  /** Optional composite runner; absent preserves the single-provider path. */
  readonly runner?: ApiRunner;
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
  /**
   * Raw-output retention store for the optimizer + `tool_output_retrieve`.
   * The launcher passes a RUN-SCOPED store so a `tool-output://` handle
   * referenced during this run cannot be evicted by unrelated historical
   * output before the model retrieves it. Defaults to the shared store.
   */
  readonly rawStore?: RawOutputStore;
  /** Deterministic tool-result cache; when absent, no caching. */
  readonly cache?: ToolResultCache;
  /** Scope-fingerprint provider for the cache. */
  readonly scopeProvider?: ToolScopeProvider;
  /** Automatic session continuity capture (tool → concise summary), after each tool execution. */
  readonly recordToolActivity?: (tool: string, summary: string) => Promise<void>;
  /**
   * Secret-resolution source for the runner's auth headers (defaults to
   * `process.env`). The launcher passes the launch plan's resolved env so a
   * credential stored in the OS credential store reaches the runner without
   * mutating `process.env` globally.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RunApiAgentResult {
  readonly finalContent: string | null;
  readonly iterations: number;
  readonly toolCalls: number;
  /** How the loop ended — anything but `final` means the answer is partial. */
  readonly stopReason: AgentStopReason;
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

const PLACEHOLDER_GOALS = new Set(["", "(untitled)", "untitled", "n/a", "none", "-", "chat"]);
const GREETING_RE =
  /^(hi|hey|hello|yo|sup|howdy|hiya|greetings|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ty|ok(ay)?|cool|nice|got\s+it|test|testing|ping|are\s+you\s+(there|working|ok|up|alive|online))\b/i;
/** Verbs that mean the user actually wants work done. */
const TASK_VERB_RE =
  /\b(fix|add|implement|refactor|write|create|build|debug|investigate|analyze|analyse|review|update|remove|delete|rename|migrate|test|run|check|find|search|explain|document|optimi[sz]e|audit|diagnose|trace|reproduce|patch|revert|bump|release|deploy|scan|show|list|make|generate|set\s+up|look\s+at|help\s+me)\b/i;

/** Classify the session's task intent — drives first-turn tool withholding. */
export function classifyTaskIntent(query: string): "absent" | "conversational" | "task" {
  const q = query.trim();
  if (PLACEHOLDER_GOALS.has(q.toLowerCase())) return "absent";
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  if (q.length <= 60 && wordCount <= 6 && GREETING_RE.test(q) && !TASK_VERB_RE.test(q)) return "conversational";
  return "task";
}

/** Build the initial messages from the rendered context + task query, per intent. */
export function buildInitialMessages(rendered: RenderedContext, query: string): readonly AgentMessage[] {
  const system = systemToString(rendered.system);
  const intent = classifyTaskIntent(query);

  let user: string;
  if (intent === "absent") {
    user =
      (rendered.userPrefix ? `${rendered.userPrefix}\n\n` : "") +
      "No task has been specified for this session. Greet the user in one or two sentences and ask what they would like to work on. " +
      "Do NOT call any tools, explore the repository, or start work until the user gives you a concrete task.";
  } else if (intent === "conversational") {
    user =
      (rendered.userPrefix ? `${rendered.userPrefix}\n\n` : "") +
      `The user said: ${query}\n\n` +
      "Reply directly and briefly. Do NOT call any tools or start work unless the user asks for something concrete.";
  } else {
    user = rendered.userPrefix ? `${rendered.userPrefix}\n\n${query}` : query;
  }

  const messages: AgentMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  return messages;
}

export async function runApiAgent(deps: RunApiAgentDeps): Promise<RunApiAgentResult> {
  const messages = buildInitialMessages(deps.rendered, deps.query);
  const runner = deps.runner ?? createApiRunner(deps.adapter, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    onRetry: (info) => {
      const delayS = (info.delayMs / 1000).toFixed(1);
      deps.onOutput?.(`${deps.adapter.profile.displayName} API connection failed — ${info.host} ${retryReason(info.kind)}. Retry ${info.attempt}/${info.maxAttempts} in ${delayS}s.\n`);
    },
  });
  const rawStore = deps.rawStore ?? defaultRawStore;
  const optimizeOutput =
    deps.optimizeOutput ?? ((toolName: string, text: string) => optimizeToolOutput(toolName, text, DEFAULT_OPTIMIZE_OPTIONS, rawStore));
  const result = await runAgentLoop(messages, {
    runner,
    tools: deps.tools,
    limits: deps.limits,
    optimizeOutput,
    cache: deps.cache,
    scopeProvider: deps.scopeProvider,
    taskIntent: classifyTaskIntent(deps.query),
    onEvent: (event, detail) => deps.onOutput?.(`[${event}] ${detail}\n`),
    onToolActivity: deps.recordToolActivity ? (tool, summary) => deps.recordToolActivity!(tool, summary) : undefined,
  });
  return { finalContent: result.finalContent, iterations: result.iterations, toolCalls: result.toolCalls, stopReason: result.stopReason };
}
