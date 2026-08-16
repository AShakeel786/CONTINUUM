export * from "./types.js";
export * from "./errors.js";
export { secretRef, resolveSecret, isSecretResolvable } from "./secrets.js";
export type { SecretRef } from "./secrets.js";
export { ProviderRegistry } from "./registry.js";
export { createProviderAdapter } from "./adapter.js";
export { claudeProfile } from "./profiles/claude.js";
export { deepseekProfile } from "./profiles/deepseek.js";
export { codexProfile } from "./profiles/codex.js";

import { createProviderAdapter } from "./adapter.js";
import { claudeProfile } from "./profiles/claude.js";
import { deepseekProfile } from "./profiles/deepseek.js";
import { codexProfile } from "./profiles/codex.js";
import { ProviderRegistry } from "./registry.js";

/**
 * Build the default registry with today's providers registered.
 * Adding a future provider (Gemini, a local model) means adding a
 * profile + one `register()` call here — never touching runtime routing
 * elsewhere in CONTINUUM (Phase 3 closure criterion #3).
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(createProviderAdapter(claudeProfile));
  registry.register(createProviderAdapter(deepseekProfile));
  registry.register(createProviderAdapter(codexProfile));
  return registry;
}
