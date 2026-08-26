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

    // Not wired into CONTINUUM yet: distinguish "native CLI is usable" from
    // "not installed", rather than a flat (and misleading) "not configured".
    if (!entry) {
      if (metadata.api.supported && metadata.api.credentialRef.providerId !== metadata.providerId) {
        const shared = await verifier.verifyApi(metadata);
        if (shared.outcome === "ok") {
          out(`${metadata.providerId}: authenticated (shared ${metadata.api.credentialRef.label ?? "API"} credential)\n`);
        } else {
          out(`${metadata.providerId}: unavailable (${shared.detail})\n`);
        }
        continue;
      }
      if (metadata.cli.supported) {
        const installed = await ctx.cliAuthManager.checkInstalled(metadata.providerId);
        if (installed === "not-installed") {
          out(`${metadata.providerId}: not installed (${metadata.cli.executable} not found)\n`);
          continue;
        }
        const auth = await ctx.cliAuthManager.checkAuthenticated(metadata.providerId);
        if (auth === "authenticated") {
          out(`${metadata.providerId}: CLI detected — native login usable (run "continuum auth ${metadata.providerId}" to finish CONTINUUM wiring)\n`);
        } else if (auth === "not-authenticated") {
          out(`${metadata.providerId}: CLI detected — not authenticated (run "continuum auth ${metadata.providerId}")\n`);
        } else {
          out(`${metadata.providerId}: CLI detected — auth unknown (run "continuum auth ${metadata.providerId}")\n`);
        }
        continue;
      }
      out(`${metadata.providerId}: not configured (run "continuum auth ${metadata.providerId}")\n`);
      continue;
    }

    const result = entry.method === "api" ? await verifier.verifyApi(metadata) : await verifier.verifyCli(metadata);
    if (result.outcome === "ok") {
      out(`${metadata.providerId}: authenticated (${entry.method})\n`);
    } else {
      out(`${metadata.providerId}: ${entry.method} — ${result.outcome} (${result.detail})\n`);
    }
  }
  return 0;
}
