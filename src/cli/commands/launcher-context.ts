/**
 * Launcher command wiring — builds the full Launcher dependency graph from
 * the same primitives the other commands use (config store, credential
 * backend, provider registry, auth metadata), plus the project registry,
 * session store, and optional MemoryCore config (resolved from env, so a
 * fresh machine simply has none and degrades gracefully).
 */

import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderRegistry } from "../../providers/index.js";
import { loadUserManifests } from "../../providers/manifest-store.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { Launcher } from "../../launcher/launcher.js";
import type { LauncherDeps } from "../../launcher/launcher.js";
import { HandoffManager } from "../../handoff/manager.js";
import { PricingAwarenessService } from "../../pricing/service.js";
import { createDefaultPricingSchedules } from "../../pricing/schedules/index.js";
import { resolveMemoryCoreConfig } from "../../context/memorycore-config.js";
import { resolveDataDir } from "../../config/paths.js";
import type { Prompt } from "../../auth/prompt.js";
import { buildContext } from "./common.js";
import { buildRepoMap, FileRepoMapCache } from "../../repo-map/repo-map.js";
import { FilePruneStore } from "../../context/pruning.js";
import { makeEnsureProxyReady } from "../../health/launch-guard.js";
import { DEFAULT_OPTIONS, DEFAULT_POLICY, liveRuntime } from "../../health/adapters.js";
import path from "node:path";

export interface LauncherContext {
  readonly launcher: Launcher;
  readonly projects: ProjectRegistry;
  readonly providers: ProviderRegistry;
  readonly sessionManager: SessionManager;
  readonly handoffManager: HandoffManager;
  readonly pricing: PricingAwarenessService;
  readonly credentialManager: CredentialManager;
  readonly configStore: import("../../config/store.js").ConfigStore;
  readonly cliAuthManager: import("../../auth/cli-auth-manager.js").CliAuthManager;
  readonly authMetadata: ReadonlyMap<string, import("../../auth/types.js").ProviderAuthMetadata>;
  readonly dataDir: string;
}

export async function buildLauncherContext(options: { dataDir?: string; prompt: Prompt; onDependencyProgress?: (line: string) => void }): Promise<LauncherContext> {
  const ctx = await buildContext({ prompt: options.prompt, dataDir: options.dataDir });
  const dataDir = options.dataDir ?? resolveDataDir();

  const projects = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const { manifests: userManifests } = await loadUserManifests(dataDir);
  const providers = createProviderRegistry(userManifests);
  const credentialManager = ctx.credentialManager;
  // buildContext already loaded user manifests into these.
  const cliAuthManager = ctx.cliAuthManager;
  const authMetadata = ctx.providerMetadata;
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });

  const sessionBaseDir = path.join(dataDir, "sessions");
  const sessionManager = new SessionManager(new FileSessionStore(sessionBaseDir));

  const memoryResolution = await resolveMemoryCoreConfig({ credentialManager });

  const repoMapCache = new FileRepoMapCache(path.join(dataDir, "repo-map"));
  const deps: LauncherDeps = {
    projects,
    providers,
    credentialManager,
    cliAuthManager,
    authVerifier,
    authMetadata,
    sessionManager,
    prompt: options.prompt,
    sessionBaseDir,
    memoryCore: memoryResolution.config,
    memoryCoreReason: memoryResolution.reason,
    repoMapBuilder: (projectPath, query, budgetTokens) => buildRepoMap(projectPath, query, { budgetTokens }, repoMapCache),
    pruneStore: new FilePruneStore(dataDir),
    ensureProxyReady: makeEnsureProxyReady({ runtime: liveRuntime, options: DEFAULT_OPTIONS, policy: DEFAULT_POLICY }),
    ...(options.onDependencyProgress ? { onDependencyProgress: options.onDependencyProgress } : {}),
  };

  const handoffManager = new HandoffManager(sessionManager, providers);
  const pricing = new PricingAwarenessService(sessionManager, providers, createDefaultPricingSchedules());

  return {
    launcher: new Launcher(deps),
    projects,
    providers,
    sessionManager,
    handoffManager,
    pricing,
    credentialManager,
    configStore: ctx.configStore,
    cliAuthManager,
    authMetadata,
    dataDir,
  };
}
