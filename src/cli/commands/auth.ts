/**
 * `continuum auth <provider> [--remove]` — (re)authenticate a single
 * provider, or remove its stored credential/config entry.
 */

import { ProviderSetup } from "../../auth/provider-setup.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { UnknownProviderError } from "../../providers/errors.js";
import type { CliIo } from "../index.js";
import { buildContext, ensureBackendRecorded } from "./common.js";

export async function runAuthCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const providerId = args.find((a) => !a.startsWith("-"));
  const remove = args.includes("--remove");

  if (!providerId) {
    out("Usage: continuum auth <provider> [--remove]\n");
    return 2;
  }

  const ctx = await buildContext({ prompt: createPrompt() });
  const metadata = ctx.providerMetadata.get(providerId);
  if (!metadata) {
    out(`Unknown provider "${providerId}". Known: ${[...ctx.providerMetadata.keys()].join(", ")}\n`);
    return 2;
  }
  await ensureBackendRecorded(ctx);

  const setup = new ProviderSetup({
    credentialManager: ctx.credentialManager,
    cliAuthManager: ctx.cliAuthManager,
    prompt: ctx.prompt,
  });
  const config = await ctx.configStore.load();

  if (remove) {
    await setup.remove(metadata);
    await ctx.configStore.save(setup.removeConfigEntry(config, providerId));
    out(`Removed stored auth for ${providerId}.\n`);
    return 0;
  }

  try {
    const result = await setup.setup(metadata);
    if (result.method === "api" && !result.credentialUri) {
      out(`No key provided for ${providerId}; nothing stored.\n`);
      return 0;
    }
    await ctx.configStore.save(setup.applyConfigEntry(config, providerId, result.method, result.credentialUri));
    out(`✓ ${providerId} configured via ${result.method}.\n`);
    return 0;
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
