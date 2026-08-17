/**
 * `continuum` (bare) — the interactive front door.
 *
 * A terminal-native menu (no GUI) that reuses existing systems only:
 * project registry (list/add/remove/detect), launcher (provider usability +
 * prepare), session list (resume), and the same preflight/pricing/launch
 * helpers the explicit `launch`/`resume` commands use. It owns no
 * provider/session/launch/registry logic of its own — only the ordering of
 * already-built pieces.
 *
 * First menu: existing projects → "+ Add project" → "Manage projects" →
 * (optional) "Register current directory as a project" → "0. Exit".
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import type { Prompt, PromptOutput } from "../../auth/prompt.js";
import { ProjectRegistry, normalizeProjectPath } from "../../registry/registry.js";
import type { ProjectRecord } from "../../registry/types.js";
import { ProjectAlreadyExistsError, ProjectNotFoundError } from "../../registry/errors.js";
import { compareTimestampsDesc, formatSessionPickerLine, listRecentSessions, type RecentSessionSummary } from "../../launcher/session-list.js";
import type { ProviderUsability } from "../../launcher/launcher.js";
import type { LaunchPreparation } from "../../launcher/types.js";
import { NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "../../launcher/errors.js";
import type { CliIo } from "../index.js";
import { buildLauncherContext } from "./launcher-context.js";
import { checkPricing, ensureMcpRegistration, launchPrepared, runLaunchPreflight } from "./launch.js";
import { isStdinTty, NON_TTY_HINT } from "./common.js";

const HEADER = "CONTINUUM\n------------";

export interface InteractiveMenuDeps {
  readonly projects: ProjectRegistry;
  readonly providers: readonly ProviderUsability[];
  readonly sessions: readonly RecentSessionSummary[];
  readonly knownProviders: ReadonlySet<string>;
  /** Launch directory — used to offer "register current directory". */
  readonly cwd: string;
}

export type InteractiveDecision =
  | { readonly kind: "new"; readonly projectId: string; readonly providerId: string; readonly taskGoal: string }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "exit" };

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Best-effort terminal column count; falls back to a sane 80-col default when unavailable (tests, pipes). */
function getTerminalColumns(): number {
  const cols = process.stdout?.columns;
  return typeof cols === "number" && cols > 0 ? cols : 80;
}

/** Present a numbered menu; returns the 0-based index, or undefined for exit/back. Labels may embed `\n` for a continuation line (indented to align under the first line). */
async function chooseNumber(
  prompt: Prompt,
  out: PromptOutput,
  title: string,
  items: readonly string[],
  exitLabel = "Exit",
): Promise<number | undefined> {
  out(`\n${title}\n`);
  items.forEach((label, i) => {
    const prefix = `  ${i + 1}. `;
    const rendered = label.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    out(`${prefix}${rendered}\n`);
  });
  out(`  0. ${exitLabel}\n`);
  for (;;) {
    const answer = (await prompt.ask("Select")).trim().toLowerCase();
    if (answer === "" || answer === "0" || answer === "q" || answer === "quit" || answer === "exit") return undefined;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    out("  (enter a number from the list, or 0)\n");
  }
}

/**
 * The pure menu/decision half of the front door. Takes the live registry +
 * already-loaded data plus a prompt, and returns what to launch (or exit).
 * Project add/remove/manage and current-directory registration happen in the
 * loop here and always return to the project menu, so a newly added project
 * is immediately launchable. Kept side-effect-light (only the injected
 * `ProjectRegistry` is mutated) so it can be tested with a scripted prompt
 * and a temp-registry-backed ProjectRegistry.
 */
export async function runInteractiveMenu(
  deps: InteractiveMenuDeps,
  prompt: Prompt,
  out: PromptOutput,
): Promise<InteractiveDecision> {
  out(`${HEADER}\n`);

  for (;;) {
    const projects = await deps.projects.list();
    const cwdDetected = deps.cwd ? await deps.projects.detect(deps.cwd) : undefined;
    const registerCwd = !!deps.cwd && !cwdDetected;

    const labels = [
      ...projects.map((p) => p.name),
      "+ Add project",
      "Manage projects",
      ...(registerCwd ? ["Register current directory as a project"] : []),
    ];
    const choice = await chooseNumber(prompt, out, "Choose project:", labels);
    if (choice === undefined) return { kind: "exit" };

    if (choice < projects.length) {
      return await chooseActionForProject(deps, projects[choice]!, prompt, out);
    }

    const special = choice - projects.length;
    if (special === 0) {
      await addProjectFlow(deps, prompt, out);
      continue;
    }
    if (special === 1) {
      await manageProjectsFlow(deps, prompt, out);
      continue;
    }
    // Register the current directory.
    await addProjectFlow(deps, prompt, out, deps.cwd);
    continue;
  }
}

/** After a project is chosen: start a new task or resume a recent session. */
async function chooseActionForProject(
  deps: InteractiveMenuDeps,
  project: ProjectRecord,
  prompt: Prompt,
  out: PromptOutput,
): Promise<InteractiveDecision> {
  const actionIdx = await chooseNumber(prompt, out, "Choose action:", ["Start new task", "Resume session"]);
  if (actionIdx === undefined) return { kind: "exit" };

  if (actionIdx === 0) {
    // Start a new task in the chosen project.
    for (const d of deps.providers.filter((p) => !p.usable)) {
      out(`  (${d.displayName} unavailable: ${d.reason ?? "not authenticated"})\n`);
    }
    const usable = deps.providers.filter((p) => p.usable);
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
  const scoped = deps.sessions.filter((s) => s.projectId === project.id);
  const rawPool = scoped.length > 0 ? scoped : deps.sessions;
  if (rawPool.length === 0) {
    out("\nNo sessions to resume yet.\n");
    return { kind: "exit" };
  }
  if (scoped.length === 0) out(`\n(no sessions for "${project.name}" — showing all recent)\n`);

  // Most recently active first — the picker never assumes its input is already
  // sorted, so a future caller passing unsorted sessions can't break the marker.
  const pool = [...rawPool].sort((a, b) => compareTimestampsDesc(a.updatedAt, b.updatedAt));
  const now = new Date();
  const width = getTerminalColumns();
  const labels = pool.map((s, i) => formatSessionPickerLine(s, { isNewest: i === 0, now, width }));
  const sessionIdx = await chooseNumber(prompt, out, "Choose session:", labels);
  if (sessionIdx === undefined) return { kind: "exit" };
  return { kind: "resume", sessionId: pool[sessionIdx]!.sessionId };
}

/**
 * Prompt for name/path/provider and add through the existing ProjectRegistry.
 * When `presetPath` is set (register-current-directory), the path is fixed and
 * the name defaults to the directory basename.
 */
async function addProjectFlow(
  deps: InteractiveMenuDeps,
  prompt: Prompt,
  out: PromptOutput,
  presetPath?: string,
): Promise<void> {
  if (presetPath) {
    out(`\nRegister current directory as a project (${presetPath}).\n`);
  } else {
    out("\n— Add project —\n");
  }

  const defaultName = presetPath ? basename(presetPath) : "";
  const name = (await prompt.ask("Project name", defaultName)).trim();
  if (!name) {
    out("(cancelled: no name)\n");
    return;
  }

  const path = (presetPath ?? (await prompt.ask("Project path", deps.cwd))).trim();
  if (!path) {
    out("(cancelled: no path)\n");
    return;
  }
  if (!isDirectory(path)) {
    out(`Path does not exist or is not a directory: ${path}\n`);
    return;
  }

  const provider = (await prompt.ask("Default provider (optional)", "")).trim();
  if (provider && !deps.knownProviders.has(provider)) {
    out(`Unknown provider "${provider}". Known: ${[...deps.knownProviders].join(", ")}\n`);
    return;
  }

  try {
    const record = await deps.projects.add({
      name,
      path: normalizeProjectPath(path),
      ...(provider ? { defaultProvider: provider } : {}),
    });
    out(`✓ Added project "${record.name}" at ${record.path}.\n`);
  } catch (err) {
    if (err instanceof ProjectAlreadyExistsError) {
      out(`${err.message}\n`);
      return;
    }
    throw err;
  }
}

/** Minimal project management: list / remove / show details / set default. */
async function manageProjectsFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  for (;;) {
    const choice = await chooseNumber(
      prompt,
      out,
      "Manage projects:",
      ["List projects", "Remove project", "Show project details", "Set default provider"],
      "Back",
    );
    if (choice === undefined) return;

    const projects = await deps.projects.list();

    if (choice === 0) {
      out("\nProjects:\n");
      if (projects.length === 0) {
        out("  (none)\n");
        continue;
      }
      for (const p of projects) {
        const def = p.defaultProvider ? ` [default: ${p.defaultProvider}${p.defaultModel ? `/${p.defaultModel}` : ""}]` : "";
        out(`  - ${p.name}${def}\n    ${p.path}\n`);
      }
      continue;
    }

    if (choice === 1) {
      if (projects.length === 0) {
        out("\nNo projects to remove.\n");
        continue;
      }
      const idx = await chooseNumber(prompt, out, "Remove project:", projects.map((p) => p.name), "Back");
      if (idx === undefined) continue;
      const p = projects[idx]!;
      if (!(await prompt.confirm(`Remove "${p.name}"?`, false))) {
        out("(cancelled)\n");
        continue;
      }
      try {
        await deps.projects.remove(p.id);
        out(`✓ Removed "${p.name}".\n`);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          out(`${err.message}\n`);
          continue;
        }
        throw err;
      }
      continue;
    }

    if (choice === 2) {
      // Show details.
      if (projects.length === 0) {
        out("\nNo projects to show.\n");
        continue;
      }
      const idx = await chooseNumber(prompt, out, "Show project:", projects.map((p) => p.name), "Back");
      if (idx === undefined) continue;
      const p = projects[idx]!;
      out(`\n${p.name}\n  path: ${p.path}\n`);
      out(p.defaultProvider ? `  default provider: ${p.defaultProvider}${p.defaultModel ? `/${p.defaultModel}` : ""}\n` : "  default provider: (none)\n");
      if (p.aliases.length) out(`  aliases: ${p.aliases.join(", ")}\n`);
      continue;
    }

    // Set default provider.
    if (projects.length === 0) {
      out("\nNo projects to update.\n");
      continue;
    }
    const idx = await chooseNumber(prompt, out, "Set default provider for:", projects.map((p) => p.name), "Back");
    if (idx === undefined) continue;
    const p = projects[idx]!;
    const known = [...deps.knownProviders];
    const provider = (await prompt.ask(`Default provider [${known.join("/")}]`, p.defaultProvider ?? "")).trim();
    if (!provider) {
      out("(cancelled)\n");
      continue;
    }
    if (!deps.knownProviders.has(provider)) {
      out(`Unknown provider "${provider}". Known: ${known.join(", ")}\n`);
      continue;
    }
    const updated = await deps.projects.update(p.id, { defaultProvider: provider });
    out(`✓ Default provider for "${p.name}" set to ${updated.defaultProvider}.\n`);
  }
}

export async function runInteractiveCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  if (!isStdinTty()) {
    out(`${NON_TTY_HINT}\n`);
    return 2;
  }
  const prompt = createPrompt();
  const ctx = await buildLauncherContext({ prompt });

  const [providers, sessions] = await Promise.all([
    ctx.launcher.listProviderUsability(),
    listRecentSessions(ctx.sessionManager, 20),
  ]);

  const decision = await runInteractiveMenu(
    {
      projects: ctx.projects,
      providers,
      sessions,
      knownProviders: new Set(ctx.providers.listIds()),
      cwd: process.cwd(),
    },
    prompt,
    out,
  );
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
