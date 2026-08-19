/**
 * `continuum` CLI entrypoint.
 *
 * A plain, dependency-free argument dispatcher. Commands:
 *
 *   continuum setup            first-run onboarding + provider auth
 *   continuum providers        list providers and their auth state
 *   continuum auth <provider>  (re)authenticate one provider [--remove]
 *   continuum doctor           read-only health report
 *
 * No secret is ever written to stdout by any command; `--version`/`help`
 * print only static text. The entrypoint is a thin wrapper that builds the
 * shared wiring (config store, credential backend, provider metadata, CLI
 * auth manager) once and hands it to the relevant command module. Keeping
 * command logic in separate modules (`commands/*.ts`) lets each be tested
 * without spawning the real argv/stdio, and keeps this file small.
 */

import { runSetupCommand } from "./commands/setup.js";
import { runInteractiveCommand } from "./commands/interactive.js";
import { runProvidersCommand } from "./commands/providers.js";
import { runModelsCommand } from "./commands/models.js";
import { getVersion } from "../version.js";
import { runAuthCommand } from "./commands/auth.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runProjectCommand } from "./commands/project.js";
import { runProviderCommand } from "./commands/provider.js";
import { runLaunchCommand, runResumeCommand, runHandoffCommand } from "./commands/launch.js";
import { runSessionsCommand } from "./commands/sessions.js";
import { runMcpCommand } from "./commands/mcp.js";
import { runMcpSetupCommand } from "./commands/mcp-setup.js";
import type { PromptOutput } from "../auth/prompt.js";
import { runCostCommand } from "./commands/cost.js";
import { runDeepSeekSmokeCommand } from "./commands/test-deepseek.js";

export interface CliIo {
  readonly out?: PromptOutput;
  readonly nonInteractive?: boolean;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv.slice(2);

  const io: CliIo = { out: (text) => process.stdout.write(text) };

  // `--help` / `-h` must NEVER execute a command (the audit found
  // `continuum launch --help` actually launched and created a session). Handled
  // centrally before any command wiring runs, so it is side-effect free.
  if (hasHelpFlag(rest)) {
    printCommandHelp(command, io);
    return 0;
  }

  switch (command) {
    case undefined:
      // Bare `continuum` opens the interactive front door (project → action →
      // provider/session → launch), never just the help text.
      return runInteractiveCommand(rest, io);
    case "--help":
    case "-h":
    case "help":
      printHelp(io);
      return 0;
    case "--version":
    case "-v":
    case "version":
      printVersion(io);
      return 0;
    case "setup":
      return runSetupCommand(rest, io);
    case "providers":
      return runProvidersCommand(rest, io);
    case "models":
      return runModelsCommand(rest, io);
    case "auth":
      return runAuthCommand(rest, io);
    case "doctor":
      return runDoctorCommand(rest, io);
    case "project":
      return runProjectCommand(rest, io);
    case "provider":
      return runProviderCommand(rest, io);
    case "launch":
    case "run":
      return runLaunchCommand(rest, io);
    case "resume":
      return runResumeCommand(rest, io);
    case "handoff":
      return runHandoffCommand(rest, io);
    case "sessions":
      return runSessionsCommand(rest, io);
    case "mcp":
      return runMcpCommand(rest, io);
    case "mcp-setup":
      return runMcpSetupCommand(rest, io);
    case "cost":
      return runCostCommand(rest, io);
    case "test":
      if (rest[0] === "deepseek") return runDeepSeekSmokeCommand(rest.slice(1), io);
      io.out?.("Usage: continuum test deepseek [--max-usd=0.05]\n");
      return 2;
    default:
      io.out?.(`Unknown command "${command}".\n`);
      printHelp(io);
      return 2;
  }
}

function printHelp(io: CliIo): void {
  io.out?.(
    [
      "CONTINUUM — multi-agent development runtime",
      "",
      "Usage: continuum <command>",
      "",
      "Commands:",
      "  setup             First-run onboarding + provider authentication",
      "  providers         List providers + auth availability (runtime/usable state)",
      "  models [provider] List the installed CLIs' current model lists (live discovery)",
      "  auth <provider>   (Re)authenticate one provider  [--remove]",
      "  doctor            Read-only health report  [--repair] [--verbose]",
      "  project <sub>     Manage projects (add/remove/list/show/set-default)",
      "  provider <sub>    Manage user provider manifests — the registry (add/list/show/remove/validate)",
      "  launch [<proj>]   Launch a task (resolve project → provider → session)",
      "  resume <session>  Resume an existing session (stale-worktree safe)",
      "  handoff <session> Hand off to an authenticated agent (never auto-selects)",
      "  sessions          List/close/archive/clean sessions",
      "  mcp               Run the MCP server (JSON-RPC over stdio)",
      "  mcp-setup         Idempotently register CONTINUUM MCP with Claude/Codex",
      "  cost [session]    Estimated DeepSeek usage/cost summary (not billing)",
      "  test deepseek     Run one bounded live DeepSeek Flash + telemetry check",
      "  --version         Print the version",
      "  --help            Show this help",
      "",
      "Tip: `providers` shows which agents are usable right now; `provider` manages the manifest registry.",
      "",
    ].join("\n"),
  );
}

function printVersion(io: CliIo): void {
  io.out?.(`continuum ${getVersion()}\n`);
}

/**
 * Flags that take a value in the subcommands. When scanning for `--help`/`-h`,
 * the token immediately following one of these is that flag's value, not a
 * help request (e.g. `continuum launch --task "--help"`).
 */
const VALUE_FLAGS = new Set([
  "--provider",
  "-p",
  "--task",
  "-t",
  "--recent",
  "--name",
  "-n",
  "--path",
  "--alias",
  "-a",
  "--model",
  "--id",
  "--protocol",
  "--base-url",
  "--auth",
  "--env",
  "--cli",
  "--older-than",
  "--limit",
]);

/** True when `args` contain a standalone `--help`/`-h` (not a value of a value-flag). */
export function hasHelpFlag(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      i += 1; // skip the flag's value token
      continue;
    }
    if (a === "--help" || a === "-h") return true;
  }
  return false;
}

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  setup: "Usage: continuum setup [--memory]\n\n  First-run onboarding + provider auth.  --memory  configure the MemoryCore gateway service token.",
  providers: "Usage: continuum providers\n\n  List providers and their runtime auth/availability (references only, never a secret).",
  models: "Usage: continuum models [<provider>]\n\n  List the model ids the installed CLIs currently support (live, read-only discovery; manifest fallback when the CLI can't be queried).",
  auth: "Usage: continuum auth <provider> [--remove]\n\n  (Re)authenticate one provider, or remove its stored credential.",
  doctor: "Usage: continuum doctor [--repair] [--verbose]\n\n  Read-only health report.  --repair  bounded recovery (cooldown + circuit breaker).\n  --verbose  show the full report even when everything is healthy.",
  project: "Usage: continuum project <add|remove|list|show|set-default>\n\n  add          continuum project add <name> <path> [--alias <a>] [--provider <id>] [--model <m>]\n               continuum project add .   (register the current directory)\n  remove       continuum project remove <name|alias|id>\n  list         list registered projects\n  show         show a project (defaults to the current directory)\n  set-default  continuum project set-default <project> <provider> [--model <m>]",
  provider: "Usage: continuum provider <add|list|show|remove|validate>\n\n  Manage user provider manifests — the manifest registry (secret-free JSON).\n  For runtime availability use `continuum providers` instead.",
  launch:
    "Usage: continuum launch [<project>|--general|--current-dir] [--provider <id>] [--task <goal>] [--bypass-permissions]\n\n  Resolve project → provider → session, then run the agent.\n  --general      no-project session (no fixed directory anchor)\n  --current-dir  session anchored to the launch directory, not registered as a project",
  run: "Usage: continuum launch [<project>] [--provider <id>] [--task <goal>]\n\n  Alias for `continuum launch`.",
  resume: "Usage: continuum resume <sessionId> [--provider <id>] | --recent N\n\n  Resume an existing session (stale-worktree safe).",
  handoff: "Usage: continuum handoff <sessionId>\n\n  Hand off to an authenticated agent (never auto-selects).",
  sessions: "Usage: continuum sessions [list] [--limit N] [--status active|archived|all]\n       continuum sessions close <id>\n       continuum sessions archive <id>\n       continuum sessions clean [--dry-run]\n       continuum sessions purge [--older-than ISO]\n\n  List (active by default), close, archive, clean smoke/test noise, or purge finished sessions.",
  mcp: "Usage: continuum mcp\n\n  Run the MCP server (JSON-RPC over stdio).",
  "mcp-setup": "Usage: continuum mcp-setup\n\n  Idempotently register CONTINUUM MCP with Claude/Codex.",
  cost: "Usage: continuum cost [sessionId]\n\n  Show estimated usage/cost telemetry; validate against DeepSeek billing exports.",
  test: "Usage: continuum test deepseek [--max-usd=0.05]\n\n  Run a bounded live Flash request, resume it, and verify native telemetry.",
};

function printCommandHelp(command: string | undefined, io: CliIo): void {
  const usage = command !== undefined ? COMMAND_USAGE[command] : undefined;
  if (usage) {
    io.out?.(`${usage}\n\nRun \`continuum --help\` for the full command list.\n`);
  } else {
    printHelp(io);
  }
}
