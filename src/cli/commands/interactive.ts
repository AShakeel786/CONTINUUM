/**
 * `continuum` (bare) — the interactive front door.
 *
 * A terminal-native menu (no GUI) that reuses existing systems only:
 * project registry (list), launcher (provider usability + prepare), session
 * list (resume), and the same preflight/pricing/launch helpers the explicit
 * `launch`/`resume` commands use. It owns no provider/session/launch logic
 * of its own — only the ordering of already-built pieces.
 *
 * Flow: header → choose project → choose action (new/resume) → choose
 * provider (new) or session (resume) → prepare + launch.
 */

import { createPrompt, noopOutput } from "../../auth/prompt.js";
import type { Prompt, PromptOutput } from "../../auth/prompt.js";
import type { ProjectRecord } from "../../registry/types.js";
import { listRecentSessions, type RecentSessionSummary } from "../../launcher/session-list.js";
import type { ProviderUsability } from "../../launcher/launcher.js";
import type { LaunchPreparation } from "../../launcher/types.js";
import { NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "../../launcher/errors.js";
import type { CliIo } from "../index.js";
import { buildLauncherContext } from "./launcher-context.js";
import { checkPricing, ensureMcpRegistration, launchPrepared, runLaunchPreflight } from "./launch.js";

const HEADER = "CONTINUUM\n------------";

export interface InteractiveMenuData {
  readonly projects: readonly ProjectRecord[];
  readonly providers: readonly ProviderUsability[];
  readonly sessions: readonly RecentSessionSummary[];
}

export type InteractiveDecision =
  | { readonly kind: "new"; readonly projectId: string; readonly providerId: string; readonly taskGoal: string }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "exit" };

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Present a numbered menu; returns the 0-based index, or undefined for exit/empty. */
async function chooseNumber(
  prompt: Prompt,
  out: PromptOutput,
  title: string,
  items: readonly string[],
): Promise<number | undefined> {
  out(`\n${title}\n`);
  items.forEach((label, i) => out(`  ${i + 1}. ${label}\n`));
  out(`  0. Exit\n`);
  for (;;) {
    const answer = (await prompt.ask("Select")).trim().toLowerCase();
    if (answer === "" || answer === "0" || answer === "q" || answer === "quit" || answer === "exit") return undefined;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    out("  (enter a number from the list, or 0 to exit)\n");
  }
}

/**
 * The pure menu/decision half of the front door — takes already-loaded data
 * plus a prompt, returns what to launch. Kept free of any filesystem/launch
 * side effects so it can be tested with a scripted prompt.
 */
export async function runInteractiveMenu(
  data: InteractiveMenuData,
  prompt: Prompt,
  out: PromptOutput,
): Promise<InteractiveDecision> {
  out(`${HEADER}\n`);

  const projects = data.projects;
  if (projects.length === 0) {
    out("\nNo projects registered yet. Add one with:\n");
    out("  continuum project add <name> <path>\n");
    return { kind: "exit" };
  }

  const projectIdx = await chooseNumber(prompt, out, "Choose project:", projects.map((p) => p.name));
  if (projectIdx === undefined) return { kind: "exit" };
  const project = projects[projectIdx]!;

  const actionIdx = await chooseNumber(prompt, out, "Choose action:", ["Start new task", "Resume session"]);
  if (actionIdx === undefined) return { kind: "exit" };

  if (actionIdx === 0) {
    // Start a new task in the chosen project.
    for (const d of data.providers.filter((p) => !p.usable)) {
      out(`  (${d.displayName} unavailable: ${d.reason ?? "not authenticated"})\n`);
    }
    const usable = data.providers.filter((p) => p.usable);
    if (usable.length === 0) {
      out("\nNo usable provider. Authenticate one first (e.g. `continuum auth codex`).\n");
      return { kind: "exit" };
    }
    const providerIdx = await chooseNumber(prompt, out, "Choose agent:", usable.map((p) => p.displayName));
    if (providerIdx === undefined) return { kind: "exit" };
    const taskGoal = await prompt.ask("Task goal (optional)", "");
    return { kind: "new", projectId: project.id, providerId: usable[providerIdx]!.providerId, taskGoal };
  }

  // Resume a recent session (scoped to the chosen project; fall back to all).
  const scoped = data.sessions.filter((s) => s.projectId === project.id);
  const pool = scoped.length > 0 ? scoped : data.sessions;
  if (pool.length === 0) {
    out("\nNo sessions to resume yet.\n");
    return { kind: "exit" };
  }
  if (scoped.length === 0) out(`\n(no sessions for "${project.name}" — showing all recent)\n`);
  const label = (s: RecentSessionSummary) => `[${s.providerId}] ${truncate(s.taskGoal, 48)}  (${s.updatedAt.slice(0, 10)})`;
  const sessionIdx = await chooseNumber(prompt, out, "Choose session:", pool.map(label));
  if (sessionIdx === undefined) return { kind: "exit" };
  return { kind: "resume", sessionId: pool[sessionIdx]!.sessionId };
}

export async function runInteractiveCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const prompt = createPrompt();
  const ctx = await buildLauncherContext({ prompt });

  const [projects, providers, sessions] = await Promise.all([
    ctx.projects.list(),
    ctx.launcher.listProviderUsability(),
    listRecentSessions(ctx.sessionManager, 20),
  ]);

  const decision = await runInteractiveMenu({ projects, providers, sessions }, prompt, out);
  if (decision.kind === "exit") return 0;

  try {
    for (const warning of await runLaunchPreflight()) out(`⚠️  ${warning}\n`);
    await ensureMcpRegistration();

    const prep: LaunchPreparation =
      decision.kind === "new"
        ? await ctx.launcher.prepareLaunch(
            { projectKey: decision.projectId, providerId: decision.providerId, taskGoal: decision.taskGoal || undefined },
            { permissionMode: "safe" },
          )
        : await ctx.launcher.prepareLaunch({ sessionId: decision.sessionId }, { permissionMode: "safe" });

    if (prep.stale) out(`⚠️  Stale state detected:\n${prep.staleReasons.map((r) => `  - ${r}`).join("\n")}\n`);
    if (prep.memoryCoreNote) out(`ℹ️  ${prep.memoryCoreNote}\n`);
    if (prep.session) out(`Session: ${prep.session.sessionId}\n`);
    if (prep.nativeResume) out(`ℹ️  Resuming ${prep.nativeResume.providerId} native session ${prep.nativeResume.nativeSessionId}\n`);

    if (prep.session) {
      const pricingLines = await checkPricing(prep.session.sessionId, ctx.pricing, ctx.handoffManager);
      for (const line of pricingLines) out(line);
    }

    return launchPrepared(
      { launcher: ctx.launcher, providers: ctx.providers, sessionManager: ctx.sessionManager, dataDir: ctx.dataDir },
      prep,
      out,
    );
  } catch (err) {
    if (err instanceof NoProjectError || err instanceof ProviderNotAuthenticatedError || err instanceof NoAuthenticatedAgentError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
