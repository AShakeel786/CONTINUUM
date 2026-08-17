/**
 * `continuum launch [<project>] [--provider <id>] [--task "<goal>"]`
 * and `continuum resume <sessionId>` and `continuum handoff <sessionId>`.
 *
 * Launch resolves project → provider → session, prepares a plan (auth env,
 * session identity, context, stale check), then spawns the provider CLI with
 * inherited stdio. Handoff asks which authenticated agent takes over — never
 * auto-selects — and re-runs the same prepare→spawn flow against the chosen
 * provider, preserving the same TaskSession.
 */

import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { spawnCli } from "../../launcher/spawn.js";
import { LocalDependencyUnavailableError, NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "../../launcher/errors.js";
import { listRecentSessions } from "../../launcher/session-list.js";
import { suggestHandoffOnPeakEvent } from "../../pricing/handoff-suggestion.js";
import type { Launcher } from "../../launcher/launcher.js";
import type { LaunchPreparation } from "../../launcher/types.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { PricingAwarenessService } from "../../pricing/service.js";
import type { HandoffManager } from "../../handoff/manager.js";
import type { SessionManager } from "../../session/manager.js";
import type { CliIo } from "../index.js";
import { ToolResultCache } from "../../tool-cache/tool-cache.js";
import { makeScopeProvider } from "../../tool-cache/scope.js";
import { buildLauncherContext } from "./launcher-context.js";
import { HealthDoctor } from "../../health/doctor.js";
import { DEFAULT_OPTIONS, DEFAULT_POLICY, liveRuntime, scanStaleProviderProcesses } from "../../health/adapters.js";
import { buildPreflightWarnings } from "../../health/preflight.js";
import { ConfigStore } from "../../config/store.js";
import { ensureMcpRegistered } from "../../mcp/registration.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { buildToolRegistry } from "../../mcp/build.js";
import { runApiAgent } from "../../api-agent/run.js";
import { ApiAgentError } from "../../api-agent/types.js";
import { join } from "node:path";
import { resolveDataDir } from "../../config/paths.js";
import { isStdinTty } from "./common.js";

/**
 * Runtime-only preflight (docker/containers/gateways/processes). Deliberately
 * excludes provider/credential probes — those live in `continuum doctor`, and
 * launch already enforces auth via prepareLaunch. Failure-tolerant: a broken
 * preflight must never block a launch.
 */
export async function runLaunchPreflight(): Promise<readonly string[]> {
  try {
    const doctor = new HealthDoctor({
      runtime: liveRuntime,
      options: { ...DEFAULT_OPTIONS, stateFile: join(resolveDataDir(), "health-state.json") },
      policy: { ...DEFAULT_POLICY },
      probes: {
        staleProcesses: async () => scanStaleProviderProcesses([...DEFAULT_OPTIONS.providerExecutables]),
      },
    });
    return buildPreflightWarnings(await doctor.diagnose());
  } catch {
    return [];
  }
}

function opt(args: readonly string[], ...flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]!) && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

/**
 * Checks the session's active-provider pricing schedule; for any peak event,
 * surfaces a handoff suggestion (message + available authenticated agents)
 * as printable lines. Never auto-selects or auto-handsoff — it only prints
 * the choice a human then makes via `continuum handoff`.
 */
export async function checkPricing(
  sessionId: string,
  pricing: PricingAwarenessService,
  handoffManager: HandoffManager,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const { events } = await pricing.check(sessionId);
    for (const ev of events) {
      const suggestion = suggestHandoffOnPeakEvent(ev, handoffManager);
      if (!suggestion) continue;
      lines.push(`💲 ${suggestion.message}\n`);
      lines.push(`   Hand off to (still in your control): ${suggestion.availableProviders.map((p) => p.providerId).join(", ")}\n`);
    }
  } catch {
    // Pricing check is advisory; a failure here must never block a launch.
  }
  return lines;
}

/**
 * After a successful (or interrupted) spawn, best-effort capture the
 * provider's most-recent native session id and persist it against the
 * CONTINUUM session. Never throws — a failed capture just means the next
 * resume falls back to the resume brief.
 */
async function recordNativeSessionAfterLaunch(launcher: Launcher, prep: LaunchPreparation, startedAtMs: number): Promise<void> {
  if (!prep.session) return;
  // Deterministic providers (Claude/DeepSeek) already recorded their id in
  // prepareLaunch — no store-scan needed (and it could pick the wrong file).
  if (launcher.supportsDeterministicSessionId(prep.providerRef.providerId)) return;
  const id = await launcher.captureNativeSessionId(prep.providerRef.providerId, startedAtMs);
  if (id) await launcher.recordNativeSessionId(prep.session.sessionId, prep.providerRef.providerId, id);
}

/**
 * Final API-agent failure report — provider, endpoint, local-vs-external,
 * exact classification, recovery attempts, and next actionable step. Built
 * entirely from `ApiAgentError`'s own fields, which never carry secrets
 * (auth headers/keys are never part of `.message`/`.host`).
 */
function formatApiAgentFailure(providerLabel: string, err: ApiAgentError): string {
  const host = err.host ?? "unknown host";
  const local = err.host ? /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(err.host) : false;
  const nextStep =
    err.kind === "auth"
      ? "Re-authenticate this provider and retry."
      : err.kind === "tls"
        ? "Check the provider's base URL/certificate configuration and retry."
        : err.kind === "http-error"
          ? "Check the provider configuration (base URL/model) and retry."
          : local
            ? "Check whether the local service is running (`continuum doctor`) and retry."
            : "Check your network connection and retry.";
  return (
    `✗ ${providerLabel} API connection failed\n` +
    `  endpoint: ${host} (${local ? "local" : "external"})\n` +
    `  failure: ${err.kind ?? "unknown"}${err.attempts ? ` after ${err.attempts} attempt(s)` : ""}\n` +
    `  ${err.message}\n` +
    `  next: ${nextStep}\n`
  );
}

/**
 * Carry a prepared launch: API providers run the generic CONTINUUM API agent;
 * CLI providers spawn their native binary (with native-session capture).
 */
export async function launchPrepared(ctx: { launcher: Launcher; providers: ProviderRegistry; sessionManager: SessionManager; dataDir: string }, prep: LaunchPreparation, out: (s: string) => void): Promise<number> {
  if (prep.runtimeKind === "api") {
    const adapter = ctx.providers.get(prep.providerRef.providerId);
    const tools = await buildToolRegistry({ dataDir: ctx.dataDir });
    const cache = new ToolResultCache({}, join(ctx.dataDir, "tool-cache"));
    const scopeProvider = makeScopeProvider({ projectPath: prep.project.path, sessionManager: ctx.sessionManager });
    const sessionId = prep.session?.sessionId;
    const recordToolActivity = sessionId
      ? (tool: string, summary: string) => ctx.sessionManager.recordToolActivity(sessionId, tool, summary).then(() => undefined)
      : undefined;
    try {
      const result = await runApiAgent({ adapter, tools, rendered: prep.rendered, query: prep.session?.taskGoal ?? "", onOutput: out, cache, scopeProvider, recordToolActivity });
      if (result.finalContent) out(`\n${result.finalContent}\n`);
      return 0;
    } catch (err) {
      if (err instanceof ApiAgentError) {
        out(formatApiAgentFailure(adapter.profile.displayName, err));
        return 1;
      }
      out(`API agent error: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  const startedAt = Date.now();
  if (!isStdinTty()) {
    out("⚠️  No interactive terminal detected — the native agent's UI may not start here.\n    Run `continuum` from a terminal window, or use a non-interactive provider.\n");
  }
  const result = await spawnCli(prep.plan);
  await recordNativeSessionAfterLaunch(ctx.launcher, prep, startedAt);
  return result.exitCode ?? 0;
}

/**
 * When the user granted one-time MCP auto-configure permission, ensure the
 * CONTINUUM MCP server is registered with the installed native CLIs before a
 * launch. Idempotent; never overwrites unrelated user MCP servers.
 */
export async function ensureMcpRegistration(): Promise<void> {
  const config = await new ConfigStore(resolveDataDir()).load();
  await ensureMcpRegistered(liveRuntime, [claudeProfile.cliLaunch, codexProfile.cliLaunch], config.mcpAutoConfigure);
}

export async function runLaunchCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const prompt = createPrompt();
  const { launcher, pricing, handoffManager, providers, sessionManager, dataDir } = await buildLauncherContext({
    prompt,
    onDependencyProgress: (line) => out(`ℹ️  ${line}\n`),
  });

  const projectKey = args.find((a) => !a.startsWith("-"));
  const providerId = opt(args, "--provider", "-p");
  const taskGoal = opt(args, "--task", "-t");
  const bypass = args.includes("--bypass-permissions") || args.includes("--dangerously-bypass");
  // No-project launches (see src/launcher/launcher.ts's SessionMode): "general"
  // has no fixed directory anchor; "current-directory" anchors to the launch
  // cwd without registering it as a project. Mutually exclusive with a
  // positional project key.
  const general = args.includes("--general");
  const currentDir = args.includes("--current-dir") || args.includes("--here");
  const mode: "general" | "current-directory" | undefined = general ? "general" : currentDir ? "current-directory" : undefined;

  try {
    // Preflight: surface stack problems BEFORE the interactive session starts.
    // Never blocks launch — degraded mode is a launcher feature, not an error.
    for (const warning of await runLaunchPreflight()) out(`⚠️  ${warning}\n`);

    const prep = await launcher.prepareLaunch(
      { ...(mode ? {} : projectKey ? { projectKey } : {}), ...(mode ? { mode } : {}), providerId, taskGoal },
      { permissionMode: bypass ? "bypass" : "safe" },
    );

    if (prep.stale) {
      out(`⚠️  Stale state detected:\n${prep.staleReasons.map((r) => `  - ${r}`).join("\n")}\n`);
    }
    if (prep.memoryCoreNote) out(`ℹ️  ${prep.memoryCoreNote}\n`);
    if (prep.session) out(`Session: ${prep.session.sessionId}\n`);
    if (prep.nativeResume) out(`ℹ️  Resuming ${prep.nativeResume.providerId} native session ${prep.nativeResume.nativeSessionId}\n`);

    // Peak-pricing handoff prompt: before launching, check the session's
    // active provider for a pricing transition; if a peak event fires, surface
    // a handoff suggestion (never auto-trigger). Only offers authenticated agents.
    if (prep.session) {
      const pricingLines = await checkPricing(prep.session.sessionId, pricing, handoffManager);
      for (const line of pricingLines) out(line);
    }

    await ensureMcpRegistration();
    return launchPrepared({ launcher, providers, sessionManager, dataDir }, prep, out);
  } catch (err) {
    if (err instanceof NoProjectError || err instanceof ProviderNotAuthenticatedError || err instanceof NoAuthenticatedAgentError || err instanceof LocalDependencyUnavailableError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

export async function runResumeCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const sessionId = args.find((a) => !a.startsWith("-"));
  const providerId = opt(args, "--provider", "-p");
  // `--recent N` resumes the Nth most-recent session (no id to memorize).
  const recentN = Number(opt(args, "--recent") ?? "nan");

  const prompt = createPrompt();
  const { launcher, sessionManager, providers, dataDir } = await buildLauncherContext({
    prompt,
    onDependencyProgress: (line) => out(`ℹ️  ${line}\n`),
  });

  let targetSessionId = sessionId;
  if (!targetSessionId && Number.isFinite(recentN)) {
    const sessions = await listRecentSessions(sessionManager, recentN);
    targetSessionId = sessions[recentN - 1]?.sessionId;
  }
  if (!targetSessionId) {
    out("Usage: continuum resume <sessionId> [--provider X] | --recent N\n");
    return 2;
  }

  try {
    const prep = await launcher.prepareLaunch(
      { sessionId: targetSessionId, ...(providerId ? { providerId } : {}) },
      { permissionMode: "safe" },
    );
    if (prep.stale) {
      out(`⚠️  Stale state detected:\n${prep.staleReasons.map((r) => `  - ${r}`).join("\n")}\n`);
    }
    if (prep.session) out(`Resuming session: ${prep.session.sessionId} [${prep.plan.providerId}]\n`);
    if (prep.nativeResume) out(`ℹ️  Resuming ${prep.nativeResume.providerId} native session ${prep.nativeResume.nativeSessionId}\n`);
    await ensureMcpRegistration();
    return launchPrepared({ launcher, providers, sessionManager, dataDir }, prep, out);
  } catch (err) {
    if (err instanceof NoAuthenticatedAgentError || err instanceof ProviderNotAuthenticatedError || err instanceof LocalDependencyUnavailableError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

export async function runHandoffCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const sessionId = args.find((a) => !a.startsWith("-"));
  if (!sessionId) {
    out("Usage: continuum handoff <sessionId>\n");
    return 2;
  }
  const prompt = createPrompt();
  const { launcher, handoffManager, sessionManager, providers, dataDir } = await buildLauncherContext({
    prompt,
    onDependencyProgress: (line) => out(`ℹ️  ${line}\n`),
  });

  try {
    // Which *available authenticated* agents can take over — never auto-select.
    const authenticated = await launcher.listAuthenticatedProviders();
    const { session } = await handoffManager.prepareHandoff(sessionId);
    const candidates = authenticated.filter((a) => a.providerId !== session.activeProvider.providerId);
    if (candidates.length === 0) {
      out("No other authenticated agent is available to take over.\n");
      return 2;
    }

    out(`Available agents to take over: ${candidates.map((c) => c.providerId).join(", ")}\n`);
    const chosen = await prompt.ask(`Hand off to which agent? [${candidates.map((c) => c.providerId).join("/")}]`);
    const chosenId = candidates.find((c) => c.providerId === chosen)?.providerId ?? candidates[0]!.providerId;

    const targetAdapter = providers.get(chosenId);
    const result = await handoffManager.finalizeHandoff(sessionId, chosenId, {
      tokenLimits: { contextWindow: targetAdapter.getCapabilities().contextWindowTokens ?? 200_000, reservedOutput: 8192 },
    });
    out(`Handed off to ${chosenId} (session ${result.session.sessionId}, active provider set).\n`);

    // Launch the receiving agent in the same project, continuing the session.
    const prep = await launcher.prepareLaunch({ sessionId, providerId: chosenId }, { permissionMode: "safe" });
    await ensureMcpRegistration();
    return launchPrepared({ launcher, providers, sessionManager, dataDir }, prep, out);
  } catch (err) {
    if (err instanceof NoAuthenticatedAgentError || err instanceof LocalDependencyUnavailableError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
