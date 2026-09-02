export * from "./types.js";
export * from "./errors.js";
export { secretRef, resolveSecret, isSecretResolvable } from "./secrets.js";
export type { SecretRef } from "./secrets.js";
export { ProviderRegistry } from "./registry.js";
export { createProviderAdapter } from "./adapter.js";
export { claudeProfile } from "./profiles/claude.js";
export { deepseekProfile } from "./profiles/deepseek.js";
export { codexProfile } from "./profiles/codex.js";
export { antigravityProfile } from "./profiles/antigravity.js";
export { glm52FreeProfile } from "./profiles/glm-5-2-free.js";
export { discoverModelsFor, parseCliModelsOutput, parseCodexModelsCache, type DiscoveredModel, type ModelDiscoveryOptions } from "./model-discovery.js";
export * from "./manifest.js";
export * from "./manifest-store.js";
export * from "./promo.js";
export {
  bundledManifests,
  claudeManifest,
  deepseekManifest,
  codexManifest,
  antigravityManifest,
  geminiFreeManifest,
  groqFreeManifest,
  openRouterFreeManifest,
  glm52FreeManifest,
  localOrnith15Manifest,
  DEFAULT_PROVIDER_PREFERENCE_CHAIN,
} from "./presets.js";

import { createProviderAdapter } from "./adapter.js";
import { ProviderRegistry } from "./registry.js";
import { bundledManifests } from "./presets.js";
import { manifestToProfile, type ProviderManifest } from "./manifest.js";

/**
 * Build a registry from the bundled presets plus any user manifests. This is
 * the one place provider *identity* becomes a live adapter; everything else
 * branches on the profile's capability data, never on a hardcoded id.
 */
export function createProviderRegistry(userManifests: readonly ProviderManifest[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  // Reserved identity = every bundled id AND every bundled id-alias. A user
  // manifest whose id collides with one of these is a stale hand-edit that a
  // bundled preset has since superseded (e.g. `local-qwen38.json` after the
  // managed `local-ornith15` preset landed) — the bundled preset wins and the
  // shadowed user file is skipped rather than registered as a dead duplicate.
  const reserved = new Set<string>();
  for (const m of bundledManifests) {
    reserved.add(m.id);
    for (const alias of m.idAliases ?? []) reserved.add(alias);
  }
  for (const manifest of bundledManifests) {
    registry.register(createProviderAdapter(manifestToProfile(manifest)));
  }
  for (const manifest of userManifests) {
    if (reserved.has(manifest.id)) continue;
    registry.register(createProviderAdapter(manifestToProfile(manifest)));
  }
  return registry;
}

/** Bundled-only registry (backward-compatible, synchronous). */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return createProviderRegistry([]);
}
