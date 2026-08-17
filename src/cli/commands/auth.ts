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
  // Opt-in proxy routing for dual-route providers (DeepSeek → Tencent MemoryProxy).
  const proxy = args.includes("--proxy");

  if (!providerId) {
    out("Usage: continuum auth <provider> [--remove] [--proxy]\n");
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
    const next = setup.removeConfigEntry(config, providerId);
    const proxyRouting = { ...(next.proxyRouting ?? {}) };
    delete proxyRouting[providerId];
    await ctx.configStore.save({ ...next, proxyRouting });
    out(`Removed stored auth for ${providerId}.\n`);
    return 0;
  }

  try {
    const result = await setup.setup(metadata);
    if (result.method === "api" && !result.credentialUri) {
      out(`No key provided for ${providerId}; nothing stored.\n`);
      return 0;
    }
    let next = setup.applyConfigEntry(config, providerId, result.method, result.credentialUri);
    out(`✓ ${providerId} configured via ${result.method}.\n`);

    // The optional proxy user key is only collected when the provider is
    // explicitly routed through the proxy — a normal (direct) setup never
    // touches the Tencent path.
    if (metadata.proxyUserKey?.supported && proxy) {
      const proxyUri = await setup.setupProxyUserKey(metadata);
      if (proxyUri) out(`✓ ${providerId} proxy user key stored (${metadata.proxyUserKey.credentialName}).\n`);
      else out(`(no proxy user key provided for ${providerId}; it can be set later)\n`);
    }

    // Persist the routing choice.
    const proxyRouting = { ...(next.proxyRouting ?? {}) };
    if (proxy && metadata.proxyUserKey?.supported) {
      proxyRouting[providerId] = "proxy";
    } else {
      delete proxyRouting[providerId];
    }
    next = { ...next, proxyRouting };
    await ctx.configStore.save(next);
    out(`✓ ${providerId} routing: ${proxy && metadata.proxyUserKey?.supported ? "proxy" : "direct"}.\n`);
    return 0;
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
