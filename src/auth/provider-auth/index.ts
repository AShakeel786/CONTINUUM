import { CliAuthManager } from "../cli-auth-manager.js";
import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import type { ProviderAuthMetadata } from "../types.js";
import { claudeAuthMetadata, createClaudeCliAuthAdapter } from "./claude.js";
import { deepseekAuthMetadata } from "./deepseek.js";
import { codexAuthMetadata, createCodexCliAuthAdapter } from "./codex.js";
import { antigravityAuthMetadata, createAntigravityCliAuthAdapter } from "./antigravity.js";
import { manifestToAuthMetadata, manifestToCliAuthCapability, type ProviderManifest } from "../../providers/manifest.js";
import { bundledManifests } from "../../providers/presets.js";

export { claudeAuthMetadata, createClaudeCliAuthAdapter } from "./claude.js";
export { deepseekAuthMetadata } from "./deepseek.js";
export { codexAuthMetadata, createCodexCliAuthAdapter, parseCodexAuthStatus } from "./codex.js";
export { antigravityAuthMetadata, createAntigravityCliAuthAdapter, detectAntigravityAuthenticated, readActiveAccount } from "./antigravity.js";

/** Bundled + user auth metadata, keyed by provider id. */
export function createProviderAuthMetadata(userManifests: readonly ProviderManifest[] = []): ReadonlyMap<string, ProviderAuthMetadata> {
  const map = new Map<string, ProviderAuthMetadata>();
  for (const m of [...bundledManifests, ...userManifests]) {
    map.set(m.id, manifestToAuthMetadata(m));
  }
  return map;
}

/** Bundled + user CLI auth adapters. Bundled keep their custom status parsers; user providers use the generic exit-code adapter. */
export function createCliAuthManager(userManifests: readonly ProviderManifest[] = []): CliAuthManager {
  const manager = new CliAuthManager();
  manager.register(createClaudeCliAuthAdapter());
  manager.register(createCodexCliAuthAdapter());
  manager.register(createAntigravityCliAuthAdapter());
  for (const m of userManifests) {
    const cap = manifestToCliAuthCapability(m);
    if (cap) manager.register(createCliAuthAdapter(m.id, cap));
  }
  return manager;
}

/** Bundled-only (backward-compatible, synchronous). */
export function createDefaultProviderAuthMetadata(): ReadonlyMap<string, ProviderAuthMetadata> {
  return createProviderAuthMetadata([]);
}

/** Bundled-only (backward-compatible, synchronous). */
export function createDefaultCliAuthManager(): CliAuthManager {
  return createCliAuthManager([]);
}
