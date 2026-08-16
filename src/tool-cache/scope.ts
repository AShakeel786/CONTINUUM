/**
 * Default scope-fingerprint provider for the tool cache. Reads repo git state
 * (HEAD + dirty) for "project" scope and session revision for "session" scope.
 * Any failure returns undefined → the cache treats it as a miss (fail-safe).
 */

import { captureGitFingerprint } from "../session/git-fingerprint.js";
import type { SessionManager } from "../session/manager.js";
import type { ToolScopeProvider } from "./tool-cache.js";

export interface ScopeProviderDeps {
  readonly projectPath: string;
  readonly sessionManager: SessionManager;
}

export function makeScopeProvider(deps: ScopeProviderDeps): ToolScopeProvider {
  return {
    async projectFingerprint(): Promise<string | undefined> {
      try {
        const g = await captureGitFingerprint(deps.projectPath);
        return `${g.headSha ?? "nohead"}:${g.dirty ? "dirty" : "clean"}`;
      } catch {
        return undefined;
      }
    },
    async sessionFingerprint(sessionId: string): Promise<string | undefined> {
      try {
        const s = await deps.sessionManager.loadSession(sessionId);
        return `${s.revision}:${s.updatedAt}`;
      } catch {
        return undefined;
      }
    },
  };
}

/** A no-op provider that always misses — used when scope cannot be computed. */
export const noopScopeProvider: ToolScopeProvider = {};
