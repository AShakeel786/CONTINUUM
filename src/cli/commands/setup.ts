/**
 * `continuum setup` — first-run onboarding and provider auth.
 */

import { SetupWizard } from "../../auth/setup-wizard.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { memoryCoreBaseUrl, storeMemoryCoreServiceToken } from "../../context/memorycore-config.js";
import type { CliIo } from "../index.js";
import { buildContext, ensureBackendRecorded } from "./common.js";

export async function runSetupCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();

  if (args.includes("--memory")) {
    return runMemorySetup(io, out);
  }

  const ctx = await buildContext({
    prompt: createPrompt(),
    nonInteractive: false,
  });

  const wizard = new SetupWizard({
    prompt: ctx.prompt,
    cliAuthManager: ctx.cliAuthManager,
    providerMetadata: ctx.providerMetadata,
    dataDir: ctx.dataDir,
    output: out,
  });

  const state = await wizard.initialize(ctx.configStore, ctx.dataDir);
  out(`Credential backend: ${state.backend.id} (${state.backend.securityLevel})\n`);
  out(`  ${state.backend.description}\n\n`);

  const config = await wizard.run(ctx.configStore, state);
  const configured = config.providers.length;
  out(`\nSetup complete. ${configured} provider${configured === 1 ? "" : "s"} configured.\n`);
  return 0;
}

/**
 * `continuum setup --memory` — configure the MemoryCore gateway service token
 * (masked prompt → OS credential store) so launch/MCP can reach a local
 * MemoryCore. The token is never written to config or env; identity stays
 * env-configurable (documented, with the current effective values printed).
 */
async function runMemorySetup(io: CliIo, out: (s: string) => void): Promise<number> {
  const ctx = await buildContext({ prompt: createPrompt(), nonInteractive: false });
  await ensureBackendRecorded(ctx);

  out("MemoryCore service token setup\n");
  out(`Gateway endpoint: ${memoryCoreBaseUrl()} (override with CONTINUUM_MEMORY_CORE_URL)\n`);
  out("Identity (env, optional):\n");
  out(`  service=${process.env.CONTINUUM_MEMORY_CORE_SERVICE_ID ?? "default"}  team=${process.env.CONTINUUM_MEMORY_CORE_TEAM_ID ?? "default"}\n`);
  out(`  user=${process.env.CONTINUUM_MEMORY_CORE_USER_ID ?? "default"}  agent=${process.env.CONTINUUM_MEMORY_CORE_AGENT_ID ?? "default"}\n`);
  out("(Set CONTINUUM_MEMORY_CORE_TEAM_ID/_USER_ID/_AGENT_ID to match your Tencent identity if the default bucket is not yours.)\n\n");

  const token = await ctx.prompt.askSecret("MemoryCore service token");
  if (!token || !token.trim()) {
    out("(no token provided — memory stays unconfigured)\n");
    return 0;
  }

  const ref = await storeMemoryCoreServiceToken(ctx.credentialManager, token.trim());
  out(`✓ MemoryCore service token stored (${ref}) in the secure credential backend.\n`);
  out("Run `continuum doctor` to confirm, or `continuum launch` to use it.\n");
  return 0;
}
