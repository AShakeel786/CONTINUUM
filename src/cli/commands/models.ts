/**
 * `continuum models [<provider>]` — expose the CURRENT model list the
 * installed CLIs actually support (Codex: the CLI's own `models_cache.json`;
 * Antigravity: `agy models`), falling back to the manifest's static list when
 * live discovery is unavailable. This is the same discovery the launcher uses
 * to pass an explicitly-selected model through to the native CLI — read-only,
 * never a credential, never a billable call.
 */

import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { discoverModelsFor } from "../../providers/model-discovery.js";
import type { ProviderProfile } from "../../providers/types.js";
import { buildContext, isStdinTty } from "./common.js";

async function renderProviderModels(out: (s: string) => void, profile: ProviderProfile): Promise<void> {
  const lines = [`${profile.id} (${profile.displayName})`];
  const defaultModel = profile.models.default;
  const aliases = Object.entries(profile.models.aliases ?? {}).map(([alias, id]) => `${alias}=${id}`);

  let discovered: readonly { id: string; label: string }[] = [];
  try {
    discovered = await discoverModelsFor(profile);
  } catch {
    // discovery unavailable → manifest list below
  }

  const ids = discovered.length > 0 ? discovered.map((m) => m.id) : [defaultModel];
  for (const id of ids) {
    const label = discovered.find((m) => m.id === id)?.label;
    const marker = id === defaultModel ? " (default)" : "";
    const source = discovered.length > 0 ? "" : " (manifest — live discovery unavailable)";
    lines.push(`  ${id}${marker}${label && label !== id ? ` — ${label}` : ""}${source}`);
  }
  if (aliases.length > 0) lines.push(`  aliases: ${aliases.join(", ")}`);

  out(`${lines.join("\n")}\n\n`);
}

export async function runModelsCommand(args: readonly string[], io: { readonly out?: (s: string) => void }): Promise<number> {
  const out = io.out ?? noopOutput();
  if (!isStdinTty()) out("Note: model lists are the installed CLI's own discovery (read-only).\n");
  const providerId = args.find((a) => !a.startsWith("-"));

  const ctx = await buildContext({ prompt: createPrompt() });
  const profiles = providerId
    ? (() => {
        const adapter = ctx.providers.has(providerId) ? ctx.providers.get(providerId) : undefined;
        if (!adapter) {
          out(`Unknown provider "${providerId}". Known providers: ${ctx.providers.listIds().join(", ")}\n`);
          return null;
        }
        return [adapter.profile];
      })()
    : ctx.providers.listProfiles();

  if (!profiles) return 2;
  if (profiles.length === 0) {
    out("No providers registered.\n");
    return 0;
  }
  for (const profile of profiles) await renderProviderModels(out, profile);
  return 0;
}
