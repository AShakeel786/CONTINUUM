/**
 * The cross-platform daily launcher — wires the existing systems together
 * without duplicating any of them:
 *
 *   ProjectRegistry      → which project / CWD / default provider+model
 *   ProviderRegistry     → provider adapters (auth kind, launch mechanism)
 *   CredentialManager    → API-key credentials (activated into the CLI env)
 *   AuthVerifier / CliAuthManager → is this provider actually usable?
 *   SessionManager       → new vs resume; durable TaskSession identity
 *   git-fingerprint      → stale-worktree detection on resume
 *   Context Manager      → buildContextEnvelope (+ MemoryCore when available)
 *   Token Manager        → allocateBudget
 *   Rendering            → renderContextForProvider
 *   HandoffManager       → who-takes-over choice (never auto-selected)
 *   PricingAwarenessService → peak-pricing handoff prompt
 *
 * The launcher owns only *orchestration*: the sequence, the user-facing
 * prompts, and the final `spawn`. It never re-implements provider auth,
 * context assembly, session durability, or handoff — it calls the existing
 * modules. Spawning is injectable so every decision point is testable
 * without forking a real CLI.
 */

import { randomUUID } from "node:crypto";
import type { ProjectRegistry } from "../registry/registry.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { CredentialManager } from "../auth/credential-manager.js";
import type { CliAuthManager } from "../auth/cli-auth-manager.js";
import type { AuthVerifier } from "../auth/auth-verifier.js";
import type { ProviderAuthMetadata } from "../auth/types.js";
import type { SessionManager } from "../session/manager.js";
import type { ProviderRef, TaskSession } from "../session/types.js";
import { captureGitFingerprint, compareGitFingerprints } from "../session/git-fingerprint.js";
import { resolveProviderAuthEnv } from "../auth/activation.js";
import { buildContextEnvelope } from "../context/envelope.js";
import { fetchDynamicRecallFromMemoryCore, fetchStableFromMemoryCore, type MemoryCoreGatewayConfig } from "../context/memorycore-client.js";
import { allocateBudget } from "../token/budget.js";
import { renderContextForProvider } from "../rendering/render.js";
import { buildResumeInstructionsBlock } from "../handoff/resume-block.js";
import type { Prompt, PromptOutput } from "../auth/prompt.js";
import { NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "./errors.js";
import type { LaunchOptions, LaunchPlan, LaunchPreparation } from "./types.js";

export interface LauncherDeps {
  readonly projects: ProjectRegistry;
  readonly providers: ProviderRegistry;
  readonly credentialManager: CredentialManager;
  readonly cliAuthManager: CliAuthManager;
  readonly authVerifier: AuthVerifier;
  readonly authMetadata: ReadonlyMap<string, ProviderAuthMetadata>;
  readonly sessionManager: SessionManager;
  readonly prompt: Prompt;
  readonly output?: PromptOutput;
  /** Optional MemoryCore gateway config; when absent, launches degrade to caller-supplied context only. */
  memoryCore?: MemoryCoreGatewayConfig;
  readonly sessionBaseDir: string;
}

export type SpawnFn = (plan: LaunchPlan) => Promise<{ exitCode: number | null }>;

const DEFAULT_OUTPUT_RESERVE = 8192;

export class Launcher {
  constructor(private readonly deps: LauncherDeps) {}

  private get out(): PromptOutput {
    return this.deps.output ?? (() => {});
  }

  private adapterFor(providerId: string): ProviderAdapter {
    return this.deps.providers.get(providerId);
  }

  /**
   * Which providers are both installed and authenticated, so a handoff /
   * "who should take over" prompt only ever offers usable agents. Never
   * auto-selects; it only *filters to available*, and the caller/user picks.
   */
  async listAuthenticatedProviders(): Promise<readonly ProviderRef[]> {
    const result: ProviderRef[] = [];
    for (const id of this.deps.providers.listIds()) {
      const adapter = this.deps.providers.get(id);
      const metadata = this.deps.authMetadata.get(id);
      if (!metadata) continue;
      const check = await this.isProviderUsable(adapter, metadata);
      if (check.usable) {
        result.push({ providerId: id, model: adapter.resolveModel() });
      }
    }
    return result;
  }

  private async isProviderUsable(
    adapter: ProviderAdapter,
    metadata: ProviderAuthMetadata,
  ): Promise<{ usable: boolean; reason?: string }> {
    // CLI-based providers (cli auth or cli-session) must have their CLI installed + authenticated.
    if (metadata.cli.supported) {
      try {
        const installed = await this.deps.cliAuthManager.checkInstalled(adapter.profile.id);
        if (installed === "not-installed") return { usable: false, reason: `${adapter.profile.id} CLI not installed` };
        const status = await this.deps.cliAuthManager.checkAuthenticated(adapter.profile.id);
        if (status !== "authenticated") return { usable: false, reason: `${adapter.profile.id} not authenticated` };
      } catch {
        return { usable: false, reason: `${adapter.profile.id} auth check failed` };
      }
      return { usable: true };
    }
    // API-key providers must have a stored, non-empty credential.
    if (metadata.api.supported) {
      const has = await this.deps.credentialManager.hasCredential(adapter.profile.id, "api-key");
      if (!has) return { usable: false, reason: `${adapter.profile.id} has no stored API key` };
      return { usable: true };
    }
    return { usable: false, reason: `${adapter.profile.id} declares no usable auth` };
  }

  /**
   * Prepares (but does NOT execute) a launch: resolves project/provider,
   * verifies usability, builds the launch plan + context, and returns
   * everything for the caller to inspect and/or spawn. Safe-by-default.
   */
  async prepareLaunch(
    target: { projectKey?: string; cwd?: string; providerId?: string; taskGoal?: string; sessionId?: string },
    opts: LaunchOptions,
  ): Promise<LaunchPreparation> {
    // Resume path: the session already knows its project + active provider.
    const existingSession = target.sessionId
      ? await this.deps.sessionManager.loadSession(target.sessionId)
      : undefined;

    const project = target.projectKey
      ? await this.deps.projects.resolve(target.projectKey)
      : existingSession
        ? await this.deps.projects.resolve(existingSession.projectId)
        : await this.detectProjectOrThrow(target.cwd);

    // Resume: keep the session's active provider unless an explicit override
    // is given (e.g. a handoff to a different agent).
    const providerId =
      target.providerId ??
      existingSession?.activeProvider.providerId ??
      project.defaultProvider;
    if (!providerId) throw new NoAuthenticatedAgentError([]); // no default + none chosen
    const adapter = this.adapterFor(providerId);
    const metadata = this.deps.authMetadata.get(providerId);
    if (!metadata) throw new ProviderNotAuthenticatedError(providerId, "no auth metadata registered");

    const usable = await this.isProviderUsable(adapter, metadata);
    if (!usable.usable) {
      if (metadata.cli.supported) throw new ProviderNotAuthenticatedError(providerId, usable.reason ?? "not authenticated");
      throw new ProviderNotAuthenticatedError(providerId, usable.reason ?? "no API key");
    }

    const model = adapter.resolveModel(project.defaultModel);
    const providerRef: ProviderRef = { providerId, model };

    // Session identity: resume an existing session, or create a new one.
    let session: TaskSession | undefined;
    let stale = false;
    let staleReasons: readonly string[] = [];
    const currentGit = await captureGitFingerprint(project.path);

    if (existingSession) {
      session = existingSession;
      if (session.git) {
        const cmp = compareGitFingerprints(session.git, currentGit);
        stale = cmp.stale;
        staleReasons = cmp.reasons;
      }
    } else {
      const goal = target.taskGoal ?? "(no explicit goal supplied)";
      session = await this.deps.sessionManager.createSession({
        sessionId: randomUUID(),
        projectId: project.id,
        workingDirectory: project.path,
        activeProvider: providerRef,
        taskGoal: goal,
        git: currentGit,
      });
    }

    // Context assembly: MemoryCore when available, degrade gracefully otherwise.
    const memoryCoreAvailable = !!this.deps.memoryCore;
    let memoryCoreNote: string | undefined;
    const callerBlocks = [buildResumeInstructionsBlock(session, { stale, reasons: staleReasons })];

    let envelope;
    if (this.deps.memoryCore) {
      try {
        const [stable, dynamic] = await Promise.all([
          fetchStableFromMemoryCore({ ...this.deps.memoryCore, sessionId: session.sessionId, taskId: session.sessionId }),
          fetchDynamicRecallFromMemoryCore({ ...this.deps.memoryCore, sessionId: session.sessionId, taskId: session.sessionId }, session.taskGoal),
        ]);
        envelope = buildContextEnvelope({
          sessionKey: session.sessionId,
          query: session.taskGoal,
          callerBlocks,
          memoryCore: { stable, dynamic },
        });
      } catch {
        // MemoryCore unavailable — degrade to caller-only context, clearly.
        envelope = buildContextEnvelope({ sessionKey: session.sessionId, query: session.taskGoal, callerBlocks });
        memoryCoreNote = "MemoryCore unavailable — launched with local session context only (no Tencent memory).";
      }
    } else {
      envelope = buildContextEnvelope({ sessionKey: session.sessionId, query: session.taskGoal, callerBlocks });
      memoryCoreNote = "MemoryCore not configured — launched with local session context only.";
    }

    const contextWindow = adapter.getCapabilities().contextWindowTokens ?? 200_000;
    const budget = allocateBudget(envelope, { contextWindow, reservedOutput: DEFAULT_OUTPUT_RESERVE });
    const rendered = renderContextForProvider(budget.envelope, adapter);

    // Build the CLI launch plan (auth/env/session identity), merging resolved credentials.
    const basePlan = adapter.buildCliLaunchPlan({ workingDir: project.path, modelAlias: project.defaultModel });
    const authEnv = metadata.api.supported ? await this.resolveAuthEnvSafely(adapter, metadata) : {};

    const plan: LaunchPlan = {
      providerId,
      model: providerRef.model,
      executable: basePlan.executable,
      args: [...basePlan.args],
      env: { ...basePlan.env, ...authEnv },
      clearEnvVars: [...basePlan.clearEnvVars],
      workingDir: project.path,
      configDir: basePlan.configDir,
      bypassPermissions: opts.permissionMode === "bypass",
    };

    return {
      plan,
      project,
      providerRef,
      session,
      stale,
      staleReasons,
      memoryCoreAvailable,
      memoryCoreNote,
    };
  }

  private async resolveAuthEnvSafely(adapter: ProviderAdapter, metadata: ProviderAuthMetadata): Promise<Record<string, string>> {
    // Only API-key/bearer auth has an env var to populate; cli-session providers
    // rely on their own login and inject nothing.
    const envVar = metadata.api.supported ? metadata.api.envVar : undefined;
    if (!envVar) return {};
    try {
      return await resolveProviderAuthEnv(adapter, this.deps.credentialManager);
    } catch {
      return {};
    }
  }

  private async detectProjectOrThrow(cwd?: string): Promise<import("../registry/types.js").ProjectRecord> {
    const dir = cwd ?? process.cwd();
    const detected = await this.deps.projects.detect(dir);
    if (!detected) throw new NoProjectError();
    return detected;
  }
}
