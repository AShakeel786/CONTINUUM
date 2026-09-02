/**
 * Persistent interactive Direct-API session — the CONTINUUM equivalent of the
 * native coding CLIs' REPL, for providers that have no CLI of their own
 * (managed local models, API-only providers). One session keeps the same
 * conversation, project, provider, tool state and memory scope across turns
 * until the user exits.
 *
 * IO is fully injected (`InteractiveIo`) so the loop is testable without a
 * real TTY; the CLI wires a readline + stdout/stderr adapter. Per user turn
 * it calls `runAgentLoop` fresh — so the no-task guard, stall fingerprints
 * and the graceful iteration cap all reset per turn and never leak state
 * from an earlier, independent question.
 */

import type { ProviderAdapter } from "../providers/types.js";
import type { RenderedContext } from "../rendering/types.js";
import type { ToolRegistry } from "../mcp/tools.js";
import type { ToolResultCache, ToolScopeProvider } from "../tool-cache/tool-cache.js";
import type { RawOutputStore } from "../tool-output/store.js";
import { createApiRunner, type ApiRunner } from "./runner.js";
import { runAgentLoop, type AgentRunState } from "./agent.js";
import { buildInitialMessages, classifyTaskIntent } from "./run.js";
import { optimizeToolOutput } from "../tool-output/optimizer.js";
import { DEFAULT_OPTIMIZE_OPTIONS } from "../tool-output/types.js";
import { formatTelemetryFooter } from "./telemetry.js";
import type { AgentLoopLimits, AgentMessage, TurnTelemetry } from "./types.js";

export interface InteractiveIo {
  /** Read one line of user input. `null` = EOF / Ctrl-D / quit signal. */
  readLine(prompt: string): Promise<string | null>;
  /** Assistant output + info lines (stdout). */
  write(text: string): void;
  /** Transient or permanent status line (stderr). */
  status(line: string): void;
  /** Clear the current transient status line, if the surface supports it. */
  clearStatus?(): void;
}

export interface InteractiveServiceInfo {
  /** `starting` | `running-owned` | `reused-owned` | `reused-foreign` | `stopped` | `error` */
  readonly state: string;
  readonly pid?: number;
  readonly endpoint?: string;
}

export interface InteractiveSessionDeps {
  readonly adapter: ProviderAdapter;
  readonly tools: ToolRegistry;
  readonly rendered: RenderedContext;
  /** The session's initial task goal (may be blank → the model asks what to do). */
  readonly initialQuery: string;
  readonly contextLimit?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cache?: ToolResultCache;
  readonly scopeProvider?: ToolScopeProvider;
  readonly rawStore?: RawOutputStore;
  readonly limits?: AgentLoopLimits;
  readonly recordToolActivity?: (tool: string, summary: string) => Promise<void>;
  /** After each completed user↔assistant exchange (for memory capture / session logs). */
  readonly onExchange?: (userText: string, assistantText: string) => Promise<void>;
  /** Test seam — defaults to the real streaming `createApiRunner`. */
  readonly runnerFactory?: (adapter: ProviderAdapter) => ApiRunner;
  /** false disables streaming (non-stream fallback still renders the full answer). */
  readonly streaming?: boolean;
  readonly io: InteractiveIo;
  readonly info: {
    readonly sessionId: string;
    readonly projectLabel: string;
    readonly projectPath: string;
    readonly providerId: string;
    readonly model: string;
    readonly memoryScope?: string;
    /** Live managed-service state for `/status` and the exit line. */
    service(): Promise<InteractiveServiceInfo>;
  };
}

const HELP = [
  "Commands:",
  "  /help     show this help",
  "  /status   session + local service state, context usage, last telemetry",
  "  /clear    start a fresh conversation (keeps project/provider/session/memory scope)",
  "  /exit     end the chat (the local model service keeps running)",
  "Ctrl-D also ends the chat.",
].join("\n");

function stateLine(s: AgentRunState): string {
  switch (s.kind) {
    case "thinking": return "THINKING…";
    case "tool": return `TOOL ${s.name}…`;
    case "generating": return "GENERATING…";
    case "done": return "";
    case "error": return `ERROR ${s.detail}`;
  }
}

export async function runInteractiveApiSession(deps: InteractiveSessionDeps): Promise<{ turns: number; endedBy: "exit" | "eof" }> {
  const { io, info } = deps;
  const runner = (deps.runnerFactory ?? ((a) => createApiRunner(a, { ...(deps.env ? { env: deps.env } : {}) })))(deps.adapter);
  const streaming = deps.streaming !== false;
  const rawStore = deps.rawStore;
  const optimizeOutput = (name: string, text: string) =>
    optimizeToolOutput(name, text, DEFAULT_OPTIMIZE_OPTIONS, rawStore);
  const ctxLimit = deps.contextLimit ?? deps.adapter.getCapabilities().contextWindowTokens;

  let conversation: readonly AgentMessage[] = buildInitialMessages(deps.rendered, deps.initialQuery);
  let lastTelemetry: TurnTelemetry | undefined;
  let turns = 0;
  const openedWithoutTask = classifyTaskIntent(deps.initialQuery) !== "task";
  let firstRealTaskDone = false;

  const runTurn = async (userVisible: string, pushUser = false): Promise<void> => {
    let printedAny = false;
    const onChunk = streaming
      ? (delta: string) => { io.clearStatus?.(); io.write(delta); printedAny = true; }
      : undefined;
    const intent = classifyTaskIntent(userVisible);
    let turnMessages: readonly AgentMessage[] = conversation;
    if (pushUser) {
      // A concrete task after a greeting opening: one plain note so the model
      // acts on it instead of re-running the "no task yet, ask them" pattern.
      if (intent === "task" && openedWithoutTask && !firstRealTaskDone) {
        turnMessages = [...conversation, { role: "user", content: "(You now have a concrete task. Work on it directly.)" }];
        firstRealTaskDone = true;
      }
      turnMessages = [...turnMessages, { role: "user", content: userVisible }];
    }
    let result;
    try {
      result = await runAgentLoop(turnMessages, {
        runner,
        tools: deps.tools,
        ...(deps.limits ? { limits: deps.limits } : {}),
        optimizeOutput,
        ...(deps.cache ? { cache: deps.cache } : {}),
        ...(deps.scopeProvider ? { scopeProvider: deps.scopeProvider } : {}),
        taskIntent: intent,
        ...(ctxLimit ? { contextLimit: ctxLimit } : {}),
        onState: (s) => { const l = stateLine(s); if (l) io.status(l); else io.clearStatus?.(); },
        ...(onChunk ? { onStreamChunk: onChunk } : {}),
        ...(deps.recordToolActivity ? { onToolActivity: deps.recordToolActivity } : {}),
      });
    } catch (err) {
      // A provider failure ends THIS turn, never the session — the user can
      // retry, ask something smaller, or /exit. The local service is untouched.
      io.clearStatus?.();
      const msg = err instanceof Error ? err.message : String(err);
      io.status(`ERROR ${msg}`);
      io.write(`\n⚠️ The model request failed this turn: ${msg}\nThe session is still open — try again, ask something smaller, or /exit.\n`);
      // Keep the failed user turn in history so a retry has context, but drop
      // any half-built assistant/tool state.
      if (pushUser) conversation = [...conversation, { role: "user", content: userVisible }];
      turns += 1;
      return;
    }
    conversation = result.conversation;
    io.clearStatus?.();
    if (!printedAny && result.finalContent) io.write(result.finalContent);
    io.write("\n");
    lastTelemetry = result.telemetry;
    io.status(formatTelemetryFooter(result.telemetry, { partial: result.stopReason !== "final" }));
    if (deps.onExchange && result.finalContent) {
      await deps.onExchange(userVisible, result.finalContent).catch(() => {});
    }
    turns += 1;
  };

  const header = async (): Promise<string> => {
    const ctx = lastTelemetry?.contextTokens;
    const ctxStr = ctx !== undefined ? ` | ctx ${ctx >= 1000 ? (ctx / 1000).toFixed(1) + "k" : ctx}${ctxLimit ? "/" + (ctxLimit / 1000).toFixed(0) + "k" : ""}` : "";
    return `CONTINUUM | ${info.projectLabel} | ${deps.adapter.profile.displayName}${ctxStr}`;
  };

  const statusBlock = async (): Promise<string> => {
    const svc = await info.service();
    const lines = [
      `session   : ${info.sessionId}  (active)`,
      `project   : ${info.projectLabel}`,
      `           ${info.projectPath}`,
      `provider  : ${info.providerId}  ·  ${deps.adapter.profile.displayName}`,
      `model     : ${info.model}`,
      ...(info.memoryScope ? [`memory    : ${info.memoryScope}`] : []),
      `service   : ${svc.state}${svc.pid ? `  (pid ${svc.pid})` : ""}${svc.endpoint ? `  ${svc.endpoint}` : ""}`,
      lastTelemetry ? `last turn : ${formatTelemetryFooter(lastTelemetry, { done: false })}` : `last turn : (none yet)`,
    ];
    return lines.join("\n");
  };

  // ── turn 0: the initial query (blank → the model asks what to work on) ──
  io.write(`${await header()}\n\n`);
  await runTurn(deps.initialQuery);

  for (;;) {
    const line = await io.readLine("\nyou › ");
    if (line === null) return finish("eof");
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0]!.toLowerCase();
      if (cmd === "/exit" || cmd === "/quit" || cmd === "/q") return finish("exit");
      if (cmd === "/help" || cmd === "/?") { io.write(`${HELP}\n`); continue; }
      if (cmd === "/status") { io.write(`${await statusBlock()}\n`); continue; }
      if (cmd === "/clear") {
        conversation = [conversation.find((m) => m.role === "system") ?? { role: "system", content: "" }];
        lastTelemetry = undefined;
        io.write("Conversation cleared. Project, provider, session and memory scope are unchanged.\n");
        continue;
      }
      io.write(`Unknown command "${cmd}". Try /help.\n`);
      continue;
    }
    io.write(`${await header()}\n\n`);
    await runTurn(text, true);
  }

  async function finish(endedBy: "exit" | "eof"): Promise<{ turns: number; endedBy: "exit" | "eof" }> {
    io.clearStatus?.();
    const svc = await info.service().catch(() => ({ state: "unknown" } as InteractiveServiceInfo));
    const svcNote =
      svc.state === "running-owned" || svc.state === "reused-owned" || svc.state === "starting"
        ? `${deps.info.providerId} service still running${svc.pid ? ` (pid ${svc.pid})` : ""} — \`continuum local stop\` to stop it`
        : svc.state === "reused-foreign"
          ? `${deps.info.providerId} endpoint (not started by CONTINUUM) left as-is`
          : `${deps.info.providerId} service: ${svc.state}`;
    io.write(`\nSession ended · ${svcNote}\n`);
    return { turns, endedBy };
  }
}
