/**
 * `continuum` (bare) — the interactive front door.
 *
 * A terminal-native menu (no GUI) that reuses existing systems only:
 * project registry (list/add/remove), agent management (add/remove/configure/
 * list over the provider/auth/config graph), launcher (agent usability +
 * prepare), session list (resume), and the same preflight/pricing/launch
 * helpers the explicit `launch`/`resume` commands use.
 *
 * Main menu: Start new task / Resume session / Manage projects /
 * Manage AI agents / Exit.
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
import { LocalDependencyUnavailableError, NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "../../launcher/errors.js";
import { AgentManager, AgentValidationError } from "../../agents/index.js";
import type { AgentAuthFacts, AgentDescriptor } from "../../agents/index.js";
import type { ProviderAuthMethod } from "../../config/types.js";
import type { CliIo } from "../index.js";
import { buildLauncherContext } from "./launcher-context.js";
import { checkPricing, ensureMcpRegistration, launchPrepared, runLaunchPreflight } from "./launch.js";
import { isStdinTty, NON_TTY_HINT } from "./common.js";

const HEADER = "CONTINUUM\n------------";

export interface InteractiveMenuDeps {
  readonly projects: ProjectRegistry;
  readonly sessions: readonly RecentSessionSummary[];
  readonly agentManager: AgentManager;
  /** Launch directory — used to offer "register current directory" when adding a project. */
  readonly cwd: string;
}

export type InteractiveDecision =
  | {
      readonly kind: "new";
      /** Set only when a registered project was chosen; mutually exclusive with `mode`. */
      readonly projectId?: string;
      /** Set only for a no-project launch ("General" or "Current directory"); mutually exclusive with `projectId`. */
      readonly mode?: "general" | "current-directory";
      readonly providerId: string;
      readonly taskGoal: string;
    }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "exit" };

/** Internal: a sub-flow returns a launch decision or "back" (return to the main menu). */
type MenuResult = InteractiveDecision | "back";

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
 * The pure menu/decision half of the front door. Takes the live registries +
 * already-loaded sessions plus a prompt, and returns what to launch (or exit).
 * Agent/project mutations go through the injected services and are immediately
 * visible because each flow re-queries them when it runs.
 */
export async function runInteractiveMenu(
  deps: InteractiveMenuDeps,
  prompt: Prompt,
  out: PromptOutput,
): Promise<InteractiveDecision> {
  out(`${HEADER}\n`);

  for (;;) {
    const choice = await chooseNumber(
      prompt,
      out,
      "Main menu:",
      ["Start new task", "Resume session", "Manage projects", "Manage AI agents"],
      "Exit",
    );
    if (choice === undefined) return { kind: "exit" };

    const result =
      choice === 0
        ? await startNewTaskFlow(deps, prompt, out)
        : choice === 1
          ? await resumeSessionFlow(deps, prompt, out)
          : choice === 2
            ? await (async (): Promise<MenuResult> => {
                await manageProjectsFlow(deps, prompt, out);
                return "back";
              })()
            : await (async (): Promise<MenuResult> => {
                await manageAgentsFlow(deps, prompt, out);
                return "back";
              })();

    if (result === "back") continue;
    return result;
  }
}

const WORKSPACE_GENERAL_LABEL = "General / No Project";
const WORKSPACE_CURRENT_DIR_LABEL = "Current Directory";

/** Main menu → "Start new task": workspace (project / general / current directory) → agent → goal. */
async function startNewTaskFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<MenuResult> {
  const projects = await deps.projects.list();
  const workspaceLabels = [
    WORKSPACE_GENERAL_LABEL,
    `${WORKSPACE_CURRENT_DIR_LABEL}\n(${deps.cwd})`,
    ...projects.map((p) => p.name),
  ];
  const workspaceIdx = await chooseNumber(prompt, out, "Choose workspace:", workspaceLabels, "Back");
  if (workspaceIdx === undefined) return "back";

  let projectId: string | undefined;
  let mode: "general" | "current-directory" | undefined;
  if (workspaceIdx === 0) {
    mode = "general";
  } else if (workspaceIdx === 1) {
    mode = "current-directory";
  } else {
    projectId = projects[workspaceIdx - 2]!.id;
  }

  const all = await deps.agentManager.listUsable();
  const usable = all.filter((u) => u.usable);
  const unusable = all.filter((u) => !u.usable);
  for (const d of unusable) out(`  (${d.displayName} unavailable: ${d.reason ?? "not authenticated"})\n`);
  if (usable.length === 0) {
    out("\nNo usable agent. Authenticate one first (e.g. 'Manage AI agents' → Add/Configure).\n");
    return "back";
  }

  const agentIdx = await chooseNumber(prompt, out, "Choose agent:", usable.map((p) => p.displayName), "Back");
  if (agentIdx === undefined) return "back";
  const taskGoal = await prompt.ask("Task goal (optional)", "");
  return {
    kind: "new",
    ...(projectId ? { projectId } : {}),
    ...(mode ? { mode } : {}),
    providerId: usable[agentIdx]!.providerId,
    taskGoal,
  };
}

/** Main menu → "Resume session": pick the most-recent active session. */
async function resumeSessionFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<MenuResult> {
  const pool = [...deps.sessions].sort((a, b) => compareTimestampsDesc(a.updatedAt, b.updatedAt));
  if (pool.length === 0) {
    out("\nNo sessions to resume yet.\n");
    return "back";
  }
  const now = new Date();
  const width = getTerminalColumns();
  const labels = pool.map((s, i) => formatSessionPickerLine(s, { isNewest: i === 0, now, width }));
  const sessionIdx = await chooseNumber(prompt, out, "Choose session:", labels, "Back");
  if (sessionIdx === undefined) return "back";
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
  const knownIds = await deps.agentManager.knownIds();
  if (provider && !knownIds.has(provider)) {
    out(`Unknown provider "${provider}". Known: ${[...knownIds].join(", ")}\n`);
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

/** Main menu → "Manage projects": Add / Remove / List / Back. */
async function manageProjectsFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  for (;;) {
    const choice = await chooseNumber(
      prompt,
      out,
      "Manage projects:",
      ["Add project", "Remove project", "List projects"],
      "Back",
    );
    if (choice === undefined) return;

    if (choice === 0) {
      await addProjectFlow(deps, prompt, out);
      continue;
    }

    const projects = await deps.projects.list();

    if (choice === 1) {
      if (projects.length === 0) {
        out("\nNo projects to remove.\n");
        continue;
      }
      const idx = await chooseNumber(prompt, out, "Remove project:", projects.map((p) => p.name), "Back");
      if (idx === undefined) continue;
      const p = projects[idx]!;
      if (!(await prompt.confirm(`Remove "${p.name}"? This only unregisters it — the folder/files are never touched.`, false))) {
        out("(cancelled)\n");
        continue;
      }
      try {
        await deps.projects.remove(p.id);
        out(`✓ Removed "${p.name}" (its folder was not touched).\n`);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          out(`${err.message}\n`);
          continue;
        }
        throw err;
      }
      continue;
    }

    // List projects.
    out("\nProjects:\n");
    if (projects.length === 0) {
      out("  (none)\n");
      continue;
    }
    for (const p of projects) {
      const def = p.defaultProvider ? ` [default: ${p.defaultProvider}${p.defaultModel ? `/${p.defaultModel}` : ""}]` : "";
      out(`  - ${p.name}${def}\n    ${p.path}\n`);
    }
  }
}

/** Main menu → "Manage AI agents": Add / Remove / Configure / List / Back. */
async function manageAgentsFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  for (;;) {
    const choice = await chooseNumber(
      prompt,
      out,
      "Manage AI agents:",
      ["Add AI agent", "Remove AI agent", "Configure AI agent", "List agents"],
      "Back",
    );
    if (choice === undefined) return;

    if (choice === 0) {
      await addAgentFlow(deps, prompt, out);
      continue;
    }
    if (choice === 1) {
      await removeAgentFlow(deps, prompt, out);
      continue;
    }
    if (choice === 2) {
      await configureAgentFlow(deps, prompt, out);
      continue;
    }
    await listAgentsFlow(deps, prompt, out);
  }
}

async function listAgentsFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  const agents = await deps.agentManager.listDescriptors();
  out("\nAI agents:\n");
  if (agents.length === 0) {
    out("  (none)\n");
    return;
  }
  for (const a of agents) out(formatAgentLine(a));
}

function formatAgentLine(a: AgentDescriptor): string {
  const source = a.source === "builtin" ? "built-in" : "custom";
  const auth = [a.auth.cli ? "CLI" : "", a.auth.api ? "API" : ""].filter(Boolean).join("+") || "none";
  const config = a.configured ? `configured (${a.configuredMethod})` : "not configured";
  const status = a.usable ? "usable" : `unavailable${a.reason ? `: ${a.reason}` : ""}`;
  const launch = a.launchKind === "cli" ? "cli" : a.launchKind === "direct-api" ? "api" : "none";
  const cli = a.auth.cli ? ` CLI=${a.cliInstalled === false ? "not-installed" : a.cliInstalled === true ? "installed" : "unknown"}` : "";
  return `  - ${a.displayName} (${a.providerId}) [${source}] auth=${auth} launch=${launch} ${config} ${status}${cli}\n`;
}

async function addAgentFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  const descriptors = await deps.agentManager.listDescriptors();
  const unconfigured = descriptors.filter((d) => !d.configured);
  const labels = [...unconfigured.map((d) => `${d.displayName} (${d.providerId})`), "+ New custom agent"];
  const choice = await chooseNumber(prompt, out, "Add AI agent:", labels, "Back");
  if (choice === undefined) return;

  if (choice < unconfigured.length) {
    await configureAgentById(deps, prompt, out, unconfigured[choice]!.providerId);
    return;
  }
  await addCustomAgentFlow(deps, prompt, out);
}

async function configureAgentFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  const descriptors = await deps.agentManager.listDescriptors();
  if (descriptors.length === 0) {
    out("\nNo agents to configure.\n");
    return;
  }
  const idx = await chooseNumber(
    prompt,
    out,
    "Configure AI agent:",
    descriptors.map((d) => `${d.displayName} (${d.providerId})`),
    "Back",
  );
  if (idx === undefined) return;
  await configureAgentById(deps, prompt, out, descriptors[idx]!.providerId);
}

async function removeAgentFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  const descriptors = await deps.agentManager.listDescriptors();
  if (descriptors.length === 0) {
    out("\nNo agents to remove.\n");
    return;
  }
  const idx = await chooseNumber(
    prompt,
    out,
    "Remove AI agent:",
    descriptors.map((d) => `${d.displayName} (${d.providerId})`),
    "Back",
  );
  if (idx === undefined) return;
  const d = descriptors[idx]!;
  const note = d.source === "user" ? "This also removes its CONTINUUM manifest/config (never its CLI)." : "This removes only CONTINUUM's registration/auth (never the CLI or its own login).";
  if (!(await prompt.confirm(`Remove "${d.displayName}"? ${note}`, false))) {
    out("(cancelled)\n");
    return;
  }
  try {
    const result = await deps.agentManager.remove(d.providerId);
    out(`✓ Removed "${d.displayName}"${result.removedManifest ? " (manifest removed)" : ""}.\n`);
  } catch (err) {
    if (err instanceof AgentValidationError) {
      out(`${err.message}\n`);
      return;
    }
    throw err;
  }
}

/** Run auth setup for one existing agent, asking CLI-vs-API when both are supported. */
async function configureAgentById(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput, providerId: string): Promise<void> {
  const descriptor = (await deps.agentManager.listDescriptors()).find((d) => d.providerId === providerId);
  if (!descriptor) {
    out(`Unknown agent "${providerId}".\n`);
    return;
  }
  const preferred = await chooseAuthMethod(descriptor.auth, prompt);
  try {
    const updated = await deps.agentManager.configure(providerId, preferred);
    if (!updated) {
      out(`(cancelled: no credential provided for ${descriptor.displayName})\n`);
      return;
    }
    out(`✓ ${updated.displayName} configured via ${updated.configuredMethod}.\n`);
  } catch (err) {
    if (err instanceof AgentValidationError) {
      out(`${err.message}\n`);
      return;
    }
    throw err;
  }
}

async function chooseAuthMethod(auth: AgentAuthFacts, prompt: Prompt): Promise<ProviderAuthMethod | undefined> {
  if (auth.api && auth.cli) {
    const answer = (await prompt.ask("Authenticate via [cli/api]", "cli")).trim().toLowerCase();
    return answer === "api" ? "api" : "cli";
  }
  if (auth.api) return "api";
  if (auth.cli) return "cli";
  return undefined;
}

/** Wizard-driven custom agent creation, reusing the user-manifest architecture. */
async function addCustomAgentFlow(deps: InteractiveMenuDeps, prompt: Prompt, out: PromptOutput): Promise<void> {
  out("\n— Add custom AI agent —\n");

  const id = (await prompt.ask("Agent id (lowercase, e.g. 'gemini')")).trim().toLowerCase();
  if (!id) {
    out("(cancelled: no id)\n");
    return;
  }
  const displayName = (await prompt.ask("Display name", id)).trim() || id;
  const protocol = (await prompt.ask("Protocol [openai-compatible/anthropic-messages]", "openai-compatible")).trim();
  if (protocol !== "openai-compatible" && protocol !== "anthropic-messages") {
    out(`Invalid protocol "${protocol}".\n`);
    return;
  }
  const baseUrl = (await prompt.ask("Base URL")).trim();
  if (!baseUrl) {
    out("(cancelled: no base URL)\n");
    return;
  }
  const authKind = (await prompt.ask("Auth kind [api-key/bearer-token/cli-session]", "api-key")).trim();
  if (authKind !== "api-key" && authKind !== "bearer-token" && authKind !== "cli-session") {
    out(`Invalid auth kind "${authKind}".\n`);
    return;
  }
  let envVar: string | undefined;
  if (authKind === "api-key" || authKind === "bearer-token") {
    envVar = (await prompt.ask("Env var name for the key (e.g. GEMINI_API_KEY)")).trim();
    if (!envVar) {
      out("(cancelled: no env var)\n");
      return;
    }
  }
  const model = (await prompt.ask("Default model")).trim();
  if (!model) {
    out("(cancelled: no model)\n");
    return;
  }
  let cliExecutable: string | undefined;
  if (authKind === "cli-session") {
    cliExecutable = (await prompt.ask("CLI executable (e.g. gemini)")).trim();
    if (!cliExecutable) {
      out("(cancelled: a CLI executable is required for cli-session auth)\n");
      return;
    }
  }

  try {
    const added = await deps.agentManager.addCustom({
      id,
      displayName,
      protocol,
      baseUrl,
      auth: authKind,
      envVar,
      model,
      cliExecutable,
    });
    out(`✓ Added agent "${added.displayName}" (${added.providerId})${added.configured ? `, configured via ${added.configuredMethod}` : ""}.\n`);
    if (added.configured && !added.usable) {
      out(`⚠️  Configured, but not launchable right now: ${added.reason ?? "no launch path"}. It will be listed but excluded from the task agent picker.\n`);
    }
  } catch (err) {
    if (err instanceof AgentValidationError) {
      out(`${err.message}\n`);
      return;
    }
    throw err;
  }
}

export async function runInteractiveCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  if (!isStdinTty()) {
    out(`${NON_TTY_HINT}\n`);
    return 2;
  }
  const prompt = createPrompt();
  let ctx = await buildLauncherContext({ prompt, onDependencyProgress: (line) => out(`ℹ️  ${line}\n`) });

  const agentManager = new AgentManager({
    dataDir: ctx.dataDir,
    configStore: ctx.configStore,
    credentialManager: ctx.credentialManager,
    prompt,
    output: out,
  });

  const sessions = await listRecentSessions(ctx.sessionManager, 20);

  const decision = await runInteractiveMenu(
    { projects: ctx.projects, sessions, agentManager, cwd: process.cwd() },
    prompt,
    out,
  );
  if (decision.kind === "exit") return 0;

  // Rebuild the launcher context so any agent added/removed/configured during
  // this session is reflected in the launch graph (the launcher was built at
  // startup, before the menu mutated the provider graph).
  ctx = await buildLauncherContext({ prompt, onDependencyProgress: (line) => out(`ℹ️  ${line}\n`) });

  try {
    for (const warning of await runLaunchPreflight()) out(`⚠️  ${warning}\n`);
    await ensureMcpRegistration();

    const prep: LaunchPreparation =
      decision.kind === "new"
        ? await ctx.launcher.prepareLaunch(
            {
              ...(decision.projectId ? { projectKey: decision.projectId } : {}),
              ...(decision.mode ? { mode: decision.mode } : {}),
              providerId: decision.providerId,
              taskGoal: decision.taskGoal || undefined,
            },
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
    if (err instanceof NoProjectError || err instanceof ProviderNotAuthenticatedError || err instanceof NoAuthenticatedAgentError || err instanceof LocalDependencyUnavailableError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
