/**
 * Real-CLI contract checks — read-only, non-billable smoke tests that verify
 * the resume/session shapes declared in a provider profile against the
 * actually-installed CLI. If a future CLI release drops or renames a flag,
 * these checks fail clearly instead of silently producing broken launch args.
 *
 * Provider-independent: it reads only the profile's declared `nativeResume`
 * data and checks that the relevant token appears in the CLI's own `--help`
 * output. Never makes a billable call, never touches a session.
 */

import type { ProviderAdapter } from "../providers/types.js";

export interface CliShell {
  run(cmd: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface CliContractCheck {
  readonly providerId: string;
  readonly ok: boolean;
  readonly detail: string;
}

export async function verifyCliContract(shell: CliShell, adapter: ProviderAdapter): Promise<CliContractCheck> {
  const { executable } = adapter.profile.cliLaunch;
  const providerId = adapter.profile.id;

  const version = await shell.run(executable, ["--version"]);
  if (version.code !== 0) {
    return { providerId, ok: false, detail: `${executable} not installed or --version failed` };
  }

  const help = await shell.run(executable, ["--help"]);
  const helpText = `${help.stdout}\n${help.stderr}`;

  const nr = adapter.profile.cliLaunch.nativeResume;
  if (!nr || !nr.supported) {
    return { providerId, ok: true, detail: "no native-resume contract to verify" };
  }

  const missing: string[] = [];
  const resumeToken = nr.resume.kind === "flag" ? nr.resume.flag : nr.resume.subcommand;
  if (!helpText.includes(resumeToken)) missing.push(`resume token "${resumeToken}"`);
  if (nr.sessionIdFlag && !helpText.includes(nr.sessionIdFlag)) missing.push(`session-id flag "${nr.sessionIdFlag}"`);

  // Context-delivery contract: a declared system-prompt flag (Claude-family
  // `--append-system-prompt`) must actually exist in the CLI's help — never a
  // guessed flag. `prompt-only` (Codex) declares no flag, so nothing to check.
  const delivery = adapter.profile.cliLaunch.contextDelivery;
  if (delivery && delivery.kind === "append-system-prompt" && !helpText.includes(delivery.systemFlag)) {
    missing.push(`context-delivery flag "${delivery.systemFlag}"`);
  }

  // MCP-launch-supply contract: a declared MCP config flag (Claude-family
  // `--mcp-config`) must actually exist in the CLI's help — never a guessed
  // flag. `global-config` (Codex) declares no flag, so nothing to check.
  const mcpSupply = adapter.profile.cliLaunch.mcpLaunch;
  if (mcpSupply && mcpSupply.kind === "mcp-config-flag" && !helpText.includes(mcpSupply.flag)) {
    missing.push(`mcp-supply flag "${mcpSupply.flag}"`);
  }

  if (missing.length > 0) {
    return { providerId, ok: false, detail: `CLI drift: ${missing.join(", ")} not found in \`${executable} --help\`` };
  }
  return { providerId, ok: true, detail: `contract ok (${resumeToken}${nr.sessionIdFlag ? `, ${nr.sessionIdFlag}` : ""})` };
}
