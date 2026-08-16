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
import type { MemoryCoreGatewayConfig } from "../../context/memorycore-client.js";
import { resolveDataDir } from "../../config/paths.js";
import type { Prompt } from "../../auth/prompt.js";
import { buildContext } from "./common.js";
import { buildRepoMap, FileRepoMapCache } from "../../repo-map/repo-map.js";
import { FilePruneStore } from "../../context/pruning.js";
import path from "node:path";

export interface LauncherContext {
  readonly launcher: Launcher;
  readonly projects: ProjectRegistry;
  readonly providers: ProviderRegistry;
  readonly sessionManager: SessionManager;
  readonly handoffManager: HandoffManager;
  readonly pricing: PricingAwarenessService;
  readonly dataDir: string;
}

/** Builds a MemoryCore gateway config from env, or undefined when unconfigured. */
function memoryCoreFromEnv(): MemoryCoreGatewayConfig | undefined {
  const baseUrl = process.env.CONTINUUM_MEMORY_CORE_URL;
  if (!baseUrl) return undefined;
  const token = process.env.CONTINUUM_MEMORY_CORE_TOKEN;
  if (!token) return undefined;
  return {
    baseUrl,
    serviceToken: { envVar: "CONTINUUM_MEMORY_CORE_TOKEN" },
    serviceId: process.env.CONTINUUM_MEMORY_CORE_SERVICE_ID ?? "default",
    teamId: process.env.CONTINUUM_MEMORY_CORE_TEAM_ID ?? "default",
    userId: process.env.CONTINUUM_MEMORY_CORE_USER_ID ?? "default",
    agentId: process.env.CONTINUUM_MEMORY_CORE_AGENT_ID ?? "default",
    timeoutMs: 3000,
  };
}

export async function buildLauncherContext(options: { dataDir?: string; prompt: Prompt }): Promise<LauncherContext> {
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
    memoryCore: memoryCoreFromEnv(),
    repoMapBuilder: (projectPath, query, budgetTokens) => buildRepoMap(projectPath, query, { budgetTokens }, repoMapCache),
    pruneStore: new FilePruneStore(dataDir),
  };

  const handoffManager = new HandoffManager(sessionManager, providers);
  const pricing = new PricingAwarenessService(sessionManager, providers, createDefaultPricingSchedules());

  return { launcher: new Launcher(deps), projects, providers, sessionManager, handoffManager, pricing, dataDir };
}
