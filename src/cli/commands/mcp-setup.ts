/**
 * `continuum mcp-setup` — idempotently register the CONTINUUM MCP stdio server
 * with each native CLI that declares MCP support (Claude, Codex). Appends via
 * the CLI's own `mcp add` (never rewrites unrelated user MCP config); re-runs
 * are a no-op when already registered. No secrets are written.
 */

import { noopOutput } from "../../auth/prompt.js";
import { liveRuntime } from "../../health/adapters.js";
import { registerMcpIfMissing } from "../../mcp/registration.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import type { CliIo } from "../index.js";

export async function runMcpSetupCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  for (const profile of [claudeProfile, codexProfile]) {
    const adapter = createProviderAdapter(profile);
    const result = await registerMcpIfMissing(liveRuntime, adapter.profile.cliLaunch);
    const icon = result.status === "registered" || result.status === "already" ? "ok" : "!!";
    out(`${icon} ${profile.id}: ${result.detail}\n`);
  }
  return 0;
}
