/**
 * `continuum setup` — first-run onboarding and provider auth.
 */

import { SetupWizard } from "../../auth/setup-wizard.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import type { CliIo } from "../index.js";
import { buildContext } from "./common.js";

export async function runSetupCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
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
