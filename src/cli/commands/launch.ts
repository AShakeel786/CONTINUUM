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
import { suggestHandoffOnPeakEvent } from "../../pricing/handoff-suggestion.js";
import type { PricingAwarenessService } from "../../pricing/service.js";
import type { HandoffManager } from "../../handoff/manager.js";
import type { CliIo } from "../index.js";
import { buildLauncherContext } from "./launcher-context.js";

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

export async function runLaunchCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const prompt = createPrompt();
  const { launcher, pricing, handoffManager } = await buildLauncherContext({ prompt });

  const projectKey = args.find((a) => !a.startsWith("-"));
  const providerId = opt(args, "--provider", "-p");
  const taskGoal = opt(args, "--task", "-t");
  const bypass = args.includes("--bypass-permissions") || args.includes("--dangerously-bypass");

  try {
    const prep = await launcher.prepareLaunch(
      { ...(projectKey ? { projectKey } : {}), providerId, taskGoal },
      { permissionMode: bypass ? "bypass" : "safe" },
    );

    if (prep.stale) {
      out(`⚠️  Stale state detected:\n${prep.staleReasons.map((r) => `  - ${r}`).join("\n")}\n`);
    }
    if (prep.memoryCoreNote) out(`ℹ️  ${prep.memoryCoreNote}\n`);
    if (prep.session) out(`Session: ${prep.session.sessionId}\n`);

    // Peak-pricing handoff prompt: before launching, check the session's
    // active provider for a pricing transition; if a peak event fires, surface
    // a handoff suggestion (never auto-trigger). Only offers authenticated agents.
    if (prep.session) {
      const pricingLines = await checkPricing(prep.session.sessionId, pricing, handoffManager);
      for (const line of pricingLines) out(line);
    }

    const result = await spawnCli(prep.plan);
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
  if (!sessionId) {
    out("Usage: continuum resume <sessionId>\n");
    return 2;
  }
  const { launcher } = await buildLauncherContext({ prompt: createPrompt() });
  try {
    const prep = await launcher.prepareLaunch({ sessionId }, { permissionMode: "safe" });
    if (prep.stale) {
      out(`⚠️  Stale state detected:\n${prep.staleReasons.map((r) => `  - ${r}`).join("\n")}\n`);
    }
    if (prep.session) out(`Resuming session: ${prep.session.sessionId}\n`);
    const result = await spawnCli(prep.plan);
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
    const spawnResult = await spawnCli(prep.plan);
    return spawnResult.exitCode ?? 0;
  } catch (err) {
    if (err instanceof NoAuthenticatedAgentError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
