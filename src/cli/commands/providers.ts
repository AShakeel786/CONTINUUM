/**
 * `continuum providers` — list providers and their auth state (references
 * and status only; never a secret value).
 */

import { AuthVerifier } from "../../auth/auth-verifier.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import type { CliIo } from "../index.js";
import { buildContext } from "./common.js";

export async function runProvidersCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const ctx = await buildContext({ prompt: createPrompt() });
  const config = await ctx.configStore.load();

  const verifier = new AuthVerifier({
    credentialManager: ctx.credentialManager,
    cliAuthManager: ctx.cliAuthManager,
  });

  const configuredById = new Map(config.providers.map((p) => [p.providerId, p]));

  for (const metadata of ctx.providerMetadata.values()) {
    const entry = configuredById.get(metadata.providerId);
    if (!entry) {
      // When a CLI-auth provider's CLI is present but unconfigured, say so — a
      // normal user should not have to guess whether the CLI exists.
      let hint = "";
      if (metadata.cli.supported) {
        const installed = await ctx.cliAuthManager.checkInstalled(metadata.providerId);
        if (installed === "installed") hint = ` (${metadata.cli.executable} CLI detected — run "continuum auth ${metadata.providerId}")`;
      }
      out(`${metadata.providerId}: not configured${hint}\n`);
      continue;
    }
    const result = entry.method === "api" ? await verifier.verifyApi(metadata) : await verifier.verifyCli(metadata);
    const status = result.outcome === "ok" ? "ok" : result.outcome;
    const ref = entry.method === "api" ? ` (${entry.credentialKey ?? "?"})` : "";
    out(`${metadata.providerId}: ${entry.method} — ${status}${ref}\n`);
  }
  return 0;
}
