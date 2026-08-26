/**
 * `continuum providers` — list providers and their auth state (references
 * and status only; never a secret value).
 */

import { AuthVerifier } from "../../auth/auth-verifier.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { effectiveBillingClass, effectiveFreeOnlyEligible } from "../../providers/billing.js";
import { missingEndpointParams } from "../../providers/endpoint.js";
import type { CliIo } from "../index.js";
import { buildContext, type CommandContext } from "./common.js";

/** Compact billing tag for a provider id, or undefined when unregistered. */
function billingTag(ctx: CommandContext, id: string): string | undefined {
  if (!ctx.providers.has(id)) return undefined;
  const profile = ctx.providers.get(id).profile;
  const billing = effectiveBillingClass(profile);
  const eligible = effectiveFreeOnlyEligible(profile);
  if (billing === "free" && eligible) return "free-only";
  if (billing === "free") return "free (not pool-eligible)";
  if (billing === "trial") return "trial";
  return "paid";
}

/** Required-but-missing endpoint params (e.g. a Cloudflare account id). */
function missingParamsTag(ctx: CommandContext, id: string): string | undefined {
  if (!ctx.providers.has(id)) return undefined;
  const missing = missingEndpointParams(ctx.providers.get(id).profile, process.env);
  return missing.length > 0 ? `missing ${missing.join(", ")}` : undefined;
}

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
    const id = metadata.providerId;
    const entry = configuredById.get(id);
    const tag = billingTag(ctx, id);
    const tagSuffix = tag ? ` — ${tag}` : "";
    const missing = missingParamsTag(ctx, id);
    const missingSuffix = missing ? ` (${missing})` : "";

    // Not wired into CONTINUUM yet: distinguish "native CLI is usable" from
    // "not installed", rather than a flat (and misleading) "not configured".
    if (!entry) {
      if (metadata.api.supported && metadata.api.credentialRef.providerId !== metadata.providerId) {
        const shared = await verifier.verifyApi(metadata);
        if (shared.outcome === "ok") {
          out(`${id}: authenticated (shared ${metadata.api.credentialRef.label ?? "API"} credential)${tagSuffix}${missingSuffix}\n`);
        } else {
          out(`${id}: unavailable (${shared.detail})${tagSuffix}${missingSuffix}\n`);
        }
        continue;
      }
      if (metadata.cli.supported) {
        const installed = await ctx.cliAuthManager.checkInstalled(id);
        if (installed === "not-installed") {
          out(`${id}: not installed (${metadata.cli.executable} not found)${tagSuffix}\n`);
          continue;
        }
        const auth = await ctx.cliAuthManager.checkAuthenticated(id);
        if (auth === "authenticated") {
          out(`${id}: CLI detected — native login usable (run "continuum auth ${id}" to finish CONTINUUM wiring)${tagSuffix}\n`);
        } else if (auth === "not-authenticated") {
          out(`${id}: CLI detected — not authenticated (run "continuum auth ${id}")${tagSuffix}\n`);
        } else {
          out(`${id}: CLI detected — auth unknown (run "continuum auth ${id}")${tagSuffix}\n`);
        }
        continue;
      }
      out(`${id}: not configured (run "continuum auth ${id}")${tagSuffix}${missingSuffix}\n`);
      continue;
    }

    const result = entry.method === "api" ? await verifier.verifyApi(metadata) : await verifier.verifyCli(metadata);
    if (result.outcome === "ok") {
      out(`${id}: authenticated (${entry.method})${tagSuffix}${missingSuffix}\n`);
    } else {
      out(`${id}: ${entry.method} — ${result.outcome} (${result.detail})${tagSuffix}${missingSuffix}\n`);
    }
  }
  return 0;
}
