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

export interface CliIo {
  readonly out?: PromptOutput;
  readonly nonInteractive?: boolean;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv.slice(2);

  const io: CliIo = { out: (text) => process.stdout.write(text) };

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
      "  providers         List providers and their auth state",
      "  auth <provider>   (Re)authenticate one provider  [--remove]",
      "  doctor            Read-only health report",
      "  project <sub>     Manage projects (add/remove/list/show)",
      "  provider <sub>    Manage user provider manifests (add/list/show/remove/validate)",
      "  launch [<proj>]   Launch a task (resolve project → provider → session)",
      "  resume <session>  Resume an existing session (stale-worktree safe)",
      "  handoff <session> Hand off to an authenticated agent (never auto-selects)",
      "  sessions          List/archive recent sessions",
      "  mcp               Run the MCP server (JSON-RPC over stdio)",
      "  mcp-setup         Idempotently register CONTINUUM MCP with Claude/Codex",
      "  --version         Print the version",
      "  --help            Show this help",
      "",
    ].join("\n"),
  );
}

function printVersion(io: CliIo): void {
  io.out?.(`continuum ${getVersion()}\n`);
}
