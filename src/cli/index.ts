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
import { runProvidersCommand } from "./commands/providers.js";
import { runAuthCommand } from "./commands/auth.js";
import { runDoctorCommand } from "./commands/doctor.js";
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
      "  --version         Print the version",
      "  --help            Show this help",
      "",
    ].join("\n"),
  );
}

function printVersion(io: CliIo): void {
  io.out?.("continuum 0.1.0 (Phase 6)\n");
}
