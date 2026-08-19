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
export { discoverModelsFor, parseCliModelsOutput, parseCodexModelsCache, type DiscoveredModel, type ModelDiscoveryOptions } from "./model-discovery.js";
export * from "./manifest.js";
export * from "./manifest-store.js";
export { bundledManifests, claudeManifest, deepseekManifest, codexManifest, antigravityManifest } from "./presets.js";

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
  for (const manifest of [...bundledManifests, ...userManifests]) {
    registry.register(createProviderAdapter(manifestToProfile(manifest)));
  }
  return registry;
}

/** Bundled-only registry (backward-compatible, synchronous). */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return createProviderRegistry([]);
}
