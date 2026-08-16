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
import { NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "../../launcher/errors.js";
import { listRecentSessions } from "../../launcher/session-list.js";
import { suggestHandoffOnPeakEvent } from "../../pricing/handoff-suggestion.js";
import type { Launcher } from "../../launcher/launcher.js";
import type { LaunchPreparation } from "../../launcher/types.js";
import type { PricingAwarenessService } from "../../pricing/service.js";
import type { HandoffManager } from "../../handoff/manager.js";
import type { CliIo } from "../index.js";
import { buildLauncherContext } from "./launcher-context.js";
import { HealthDoctor } from "../../health/doctor.js";
import { DEFAULT_OPTIONS, DEFAULT_POLICY, liveRuntime, scanStaleProviderProcesses } from "../../health/adapters.js";
import { buildPreflightWarnings } from "../../health/preflight.js";
import { join } from "node:path";
import { resolveDataDir } from "../../config/paths.js";

/**
 * Runtime-only preflight (docker/containers/gateways/processes). Deliberately
 * excludes provider/credential probes — those live in `continuum doctor`, and
 * launch already enforces auth via prepareLaunch. Failure-tolerant: a broken
 * preflight must never block a launch.
 */
async function runLaunchPreflight(): Promise<readonly string[]> {
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
async function checkPricing(
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

export async function runLaunchCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const prompt = createPrompt();
  const { launcher, pricing, handoffManager } = await buildLauncherContext({ prompt });

  const projectKey = args.find((a) => !a.startsWith("-"));
  const providerId = opt(args, "--provider", "-p");
  const taskGoal = opt(args, "--task", "-t");
  const bypass = args.includes("--bypass-permissions") || args.includes("--dangerously-bypass");

  try {
    // Preflight: surface stack problems BEFORE the interactive session starts.
    // Never blocks launch — degraded mode is a launcher feature, not an error.
    for (const warning of await runLaunchPreflight()) out(`⚠️  ${warning}\n`);

    const prep = await launcher.prepareLaunch(
      { ...(projectKey ? { projectKey } : {}), providerId, taskGoal },
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

    const startedAt = Date.now();
    const result = await spawnCli(prep.plan);
    await recordNativeSessionAfterLaunch(launcher, prep, startedAt);
    return result.exitCode ?? 0;
  } catch (err) {
    if (err instanceof NoProjectError || err instanceof ProviderNotAuthenticatedError || err instanceof NoAuthenticatedAgentError) {
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
  const { launcher, sessionManager } = await buildLauncherContext({ prompt });

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
    const startedAt = Date.now();
    const result = await spawnCli(prep.plan);
    await recordNativeSessionAfterLaunch(launcher, prep, startedAt);
    return result.exitCode ?? 0;
  } catch (err) {
    if (err instanceof NoAuthenticatedAgentError || err instanceof ProviderNotAuthenticatedError) {
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
  const { launcher, handoffManager, sessionManager, providers } = await buildLauncherContext({ prompt });

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
    const startedAt = Date.now();
    const spawnResult = await spawnCli(prep.plan);
    await recordNativeSessionAfterLaunch(launcher, prep, startedAt);
    return spawnResult.exitCode ?? 0;
  } catch (err) {
    if (err instanceof NoAuthenticatedAgentError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
