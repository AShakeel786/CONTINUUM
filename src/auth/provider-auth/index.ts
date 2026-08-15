import { CliAuthManager } from "../cli-auth-manager.js";
import type { ProviderAuthMetadata } from "../types.js";
import { claudeAuthMetadata, createClaudeCliAuthAdapter } from "./claude.js";
import { deepseekAuthMetadata } from "./deepseek.js";

export { claudeAuthMetadata, createClaudeCliAuthAdapter } from "./claude.js";
export { deepseekAuthMetadata } from "./deepseek.js";

/** Mirrors Phase 3's `createDefaultProviderRegistry()` shape exactly. */
export function createDefaultProviderAuthMetadata(): ReadonlyMap<string, ProviderAuthMetadata> {
  return new Map([
    [claudeAuthMetadata.providerId, claudeAuthMetadata],
    [deepseekAuthMetadata.providerId, deepseekAuthMetadata],
  ]);
}

export function createDefaultCliAuthManager(): CliAuthManager {
  const manager = new CliAuthManager();
  manager.register(createClaudeCliAuthAdapter());
  // DeepSeek has no CLI auth capability -- correctly not registered here;
  // CliAuthManager.get("deepseek") throws UnknownProviderError, which is
  // the honest answer, not a stub adapter that always reports "unknown".
  return manager;
}
