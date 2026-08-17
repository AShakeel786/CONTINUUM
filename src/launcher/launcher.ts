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
import { renderContextForProvider, renderedSystemToText } from "../rendering/render.js";
import { buildResumeInstructionsBlock, buildSessionMaintenanceBlock } from "../handoff/resume-block.js";
import { findRecentNativeSessionId } from "./native-session.js";
import { resolveConfigDir } from "./config-dir.js";
import { mcpServerCommand } from "../mcp/registration.js";
import { repoMapBlock } from "../repo-map/repo-map.js";
import { applyReversiblePruning } from "../context/pruning.js";
import type { ContextBlock } from "../context/types.js";
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
  /** Actionable explanation surfaced when `memoryCore` is absent (config resolution failed). */
  readonly memoryCoreReason?: string;
  readonly sessionBaseDir: string;
  /** Optional repo-map builder (Token Efficiency Phase 2); when absent, no repo map is injected. */
  readonly repoMapBuilder?: (projectPath: string, query: string, budgetTokens: number) => Promise<import("../repo-map/repo-map.js").RepoMapResult>;
  /** Optional prune store (Token Efficiency Phase 4); when absent, pruning stays destructive. */
  readonly pruneStore?: import("../context/pruning.js").PruneStore;
}

export type SpawnFn = (plan: LaunchPlan) => Promise<{ exitCode: number | null }>;

/** Per-provider usability, including a human-readable display name and (when unusable) a reason — powers the interactive provider picker. */
export interface ProviderUsability {
  readonly providerId: string;
  readonly displayName: string;
  readonly model: string;
  readonly usable: boolean;
  readonly reason?: string;
}

const DEFAULT_OUTPUT_RESERVE = 8192;
const REPO_MAP_BUDGET_TOKENS = 1200;

export class Launcher {
  constructor(private readonly deps: LauncherDeps) {}

  private get out(): PromptOutput {
    return this.deps.output ?? (() => {});
  }

  private adapterFor(providerId: string): ProviderAdapter {
    return this.deps.providers.get(providerId);
  }

  /**
   * Usability of every registered provider — the single source of truth
   * behind both the authenticated-provider list (handoff) and the
   * interactive provider picker (bare `continuum`). Includes display name
   * and, when unusable, the human-readable reason, so a menu can show only
   * usable agents without duplicating the usability check.
   */
  async listProviderUsability(): Promise<readonly ProviderUsability[]> {
    const result: ProviderUsability[] = [];
    for (const id of this.deps.providers.listIds()) {
      const adapter = this.deps.providers.get(id);
      const metadata = this.deps.authMetadata.get(id);
      if (!metadata) continue;
      const check = await this.isProviderUsable(adapter, metadata);
      result.push({
        providerId: id,
        displayName: adapter.profile.displayName,
        model: adapter.resolveModel(),
        usable: check.usable,
        reason: check.reason,
      });
    }
    return result;
  }

  /**
   * Which providers are both installed and authenticated, so a handoff /
   * "who should take over" prompt only ever offers usable agents. Never
   * auto-selects; it only *filters to available*, and the caller/user picks.
   */
  async listAuthenticatedProviders(): Promise<readonly ProviderRef[]> {
    const usable = (await this.listProviderUsability()).filter((u) => u.usable);
    return usable.map((u) => ({ providerId: u.providerId, model: u.model }));
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
      // Proxy-routed providers additionally need the proxy user key (unless an
      // env var already provides it).
      if (metadata.proxyUserKey?.supported) {
        const hasProxy =
          (await this.deps.credentialManager.hasCredential(adapter.profile.id, metadata.proxyUserKey.credentialName)) ||
          !!process.env[metadata.proxyUserKey.envVar];
        if (!hasProxy) return { usable: false, reason: `${adapter.profile.id} has no proxy user key` };
      }
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
    let providerId =
      target.providerId ??
      existingSession?.activeProvider.providerId ??
      project.defaultProvider;

    // First-launch with no explicit provider and no default: prompt from the
    // *configured + authenticated* providers (never auto-select).
    if (!providerId && !existingSession) {
      providerId = await this.promptForProvider();
      if (!providerId) throw new NoAuthenticatedAgentError([]);
    }
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
      // Bump last-active on resume so the resume picker sorts by "most recently
      // worked on". Provider-change resumes already refresh `updatedAt` via
      // setActiveProvider below, so only touch the common same-provider path.
      const providerChanging = !!target.providerId && target.providerId !== session.activeProvider.providerId;
      if (!providerChanging) {
        await this.deps.sessionManager.markActive(session.sessionId).catch(() => {});
      }
      if (session.git) {
        const cmp = compareGitFingerprints(session.git, currentGit);
        stale = cmp.stale;
        staleReasons = cmp.reasons;
      }
      // Provider-change-on-resume: route through normal handoff semantics —
      // record the transition metadata and update activeProvider, exactly the
      // same state HandoffManager writes, so it never looks like a fresh task
      // and the receipt agent sees a "continue, don't re-audit" prompt. A
      // same-provider resume is a no-op (no fake handoff).
      if (providerChanging) {
        const from = session.activeProvider;
        const to: ProviderRef = { providerId, model };
        await this.deps.sessionManager.recordHandoff(session.sessionId, {
          handoffId: randomUUID(),
          fromProvider: from,
          toProvider: to,
          at: new Date().toISOString(),
        });
        session = await this.deps.sessionManager.setActiveProvider(session.sessionId, to);
      }
    } else {
      const goal = target.taskGoal ?? "(untitled)";
      session = await this.deps.sessionManager.createSession({
        sessionId: randomUUID(),
        projectId: project.id,
        workingDirectory: project.path,
        activeProvider: providerRef,
        taskGoal: goal,
        git: currentGit,
      });
    }

    // Native-session resume: only on a SAME-provider resume (not a handoff to
    // a different provider — the target there starts a fresh native session).
    // Uses the stored native id when present; otherwise undefined → fresh
    // native session + resume-brief fallback. Never fabricates an id.
    const sameProviderResume =
      existingSession !== undefined && existingSession.activeProvider.providerId === providerId;
    const resumeNativeSessionId = sameProviderResume ? session.nativeSessionIds?.[providerId] : undefined;

    // Deterministic native session id: when NOT resuming and the provider
    // declares a session-id flag (Claude/DeepSeek), set the native id equal to
    // the CONTINUUM session id up front — no newest-file discovery needed.
    // Codex declares no flag, so it keeps the store-scan fallback.
    let setSessionId: string | undefined;
    if (!resumeNativeSessionId) {
      const nr = adapter.profile.cliLaunch.nativeResume;
      if (nr?.supported && nr.sessionIdFlag) {
        setSessionId = session.sessionId;
        await this.deps.sessionManager.recordNativeSessionId(session.sessionId, providerId, session.sessionId).catch(() => {});
      }
    }

    // Context assembly: MemoryCore when available, degrade gracefully otherwise.
    const memoryCoreAvailable = !!this.deps.memoryCore;
    let memoryCoreNote: string | undefined;
    const callerBlocks: ContextBlock[] = [
      buildSessionMaintenanceBlock(session),
      buildResumeInstructionsBlock(session, { stale, reasons: staleReasons }),
    ];
    // Repo intelligence map (Token Efficiency Phase 2) — navigation-only context;
    // a build failure never blocks the launch.
    if (this.deps.repoMapBuilder) {
      try {
        const map = await this.deps.repoMapBuilder(project.path, session.taskGoal, REPO_MAP_BUDGET_TOKENS);
        const block = repoMapBlock(map, session.taskGoal);
        if (block) callerBlocks.push(block);
      } catch {
        // degrade to no repo map
      }
    }

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
      memoryCoreNote = this.deps.memoryCoreReason ?? "MemoryCore not configured — launched with local session context only.";
    }

    const contextWindow = adapter.getCapabilities().contextWindowTokens ?? 200_000;
    const budget = allocateBudget(envelope, { contextWindow, reservedOutput: DEFAULT_OUTPUT_RESERVE });
    // Reversible pruning: when the budget dropped/truncated eligible blocks,
    // persist them and replace with compact references (fail-closed).
    const finalEnvelope = this.deps.pruneStore
      ? (await applyReversiblePruning(envelope, budget, this.deps.pruneStore, session.sessionId)).envelope
      : budget.envelope;
    const rendered = renderContextForProvider(finalEnvelope, adapter);

    // Native-CLI context delivery: the same budgeted + rendered context the API
    // agent receives as its first turn is also handed to a native CLI (task
    // prompt + compact system/context), per the profile's declared delivery
    // mechanism. This closes the dogfood gap where `rendered` was discarded for
    // every native CLI launch.
    const systemText = renderedSystemToText(rendered.system);
    const contextSystem = [systemText, rendered.userPrefix].filter((s) => s.trim().length > 0).join("\n\n");
    const taskPrompt = session.taskGoal;

    // Build the CLI launch plan (auth/env/session identity), merging resolved credentials.
    // Proxy user key (deepseek proxy-routed path) is sourced from the credential
    // backend, not a manual env var — see ctx.secrets below.
    const launchCtx = await this.buildLaunchContext(adapter, metadata, project.defaultModel, project.path, resumeNativeSessionId, setSessionId, taskPrompt, contextSystem);
    const basePlan = adapter.buildCliLaunchPlan(launchCtx);
    const authEnv = metadata.api.supported ? await this.resolveAuthEnvSafely(adapter, metadata) : {};

    const plan: LaunchPlan = {
      providerId,
      model: providerRef.model,
      executable: basePlan.executable,
      args: [...basePlan.args],
      env: { ...basePlan.env, ...authEnv },
      clearEnvVars: [...basePlan.clearEnvVars],
      workingDir: project.path,
      // Resolve the bare config-dir *name* to an absolute home path so the CLI
      // never creates a repo-local `.claude-*` dir (see config-dir.ts).
      configDir: resolveConfigDir(basePlan.configDir),
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
      runtimeKind: adapter.getCapabilities().cliAvailable ? "cli" : "api",
      rendered,
      ...(resumeNativeSessionId ? { nativeResume: { providerId, nativeSessionId: resumeNativeSessionId } } : {}),
    };
  }

  /** Persist a provider-native session id after a successful launch. Never throws — a capture failure is a safe fallback, not an error. */
  async recordNativeSessionId(sessionId: string, providerId: string, nativeSessionId: string): Promise<void> {
    await this.deps.sessionManager.recordNativeSessionId(sessionId, providerId, nativeSessionId).catch(() => {});
  }

  /**
   * Best-effort discovery of the provider's most-recent native session id
   * (read-only). Returns undefined when the provider has no declared store or
   * nothing qualifies — the launcher then falls back to the resume brief.
   */
  async captureNativeSessionId(providerId: string, sinceMs = 0): Promise<string | undefined> {
    const nr = this.adapterFor(providerId).profile.cliLaunch.nativeResume;
    if (!nr || !nr.supported) return undefined;
    try {
      return await findRecentNativeSessionId(nr.sessionStore, sinceMs);
    } catch {
      return undefined;
    }
  }

  /** True when the provider sets a deterministic native id (session-id flag) — its id is recorded in prepareLaunch, not captured after spawn. */
  supportsDeterministicSessionId(providerId: string): boolean {
    const nr = this.adapterFor(providerId).profile.cliLaunch.nativeResume;
    return !!nr && nr.supported && !!nr.sessionIdFlag;
  }

  private async resolveAuthEnvSafely(adapter: ProviderAdapter, metadata: ProviderAuthMetadata): Promise<Record<string, string>> {
    // Only API-key/bearer auth has an env var to populate; cli-session providers
    // rely on their own login and inject nothing.
    const envVar = metadata.api.supported ? metadata.api.envVar : undefined;
    if (!envVar) return {};
    // Proxy-routed launches do NOT consume the upstream API key — the proxy
    // holds it server-side. Injecting it into the child env would leak it
    // unnecessarily (and it's the one credential that must stay out of a
    // proxy CLI launch). Only the proxy user key (handled separately via
    // ctx.secrets) belongs in a proxy launch.
    if (adapter.profile.cliLaunch.kind === "proxy-routed") return {};
    try {
      return await resolveProviderAuthEnv(adapter, this.deps.credentialManager);
    } catch {
      return {};
    }
  }

  /**
   * Builds the `CliLaunchContext` for a provider, resolving any launch secret
   * (the deepseek proxy user key) from the credential backend into
   * `ctx.secrets`, so `buildCliLaunchPlan` never depends on a manual env var.
   * Falls back to `process.env` for any secret not in the store (which keeps
   * backward compatibility with an explicitly-exported key).
   */
  private async buildLaunchContext(adapter: ProviderAdapter, metadata: ProviderAuthMetadata, modelAlias: string | undefined, workingDir: string, resumeNativeSessionId: string | undefined, setSessionId: string | undefined, taskPrompt: string | undefined, contextSystem: string | undefined): Promise<import("../providers/types.js").CliLaunchContext> {
    const secrets: Record<string, string> = {};
    const launch = adapter.profile.cliLaunch;
    if (launch.kind === "proxy-routed") {
      const envVar = launch.proxyUserKeySecret.envVar;
      if (envVar === undefined) throw new Error("proxy-routed provider profile is missing proxyUserKeySecret.envVar");
      const credentialName = metadata.proxyUserKey?.supported ? metadata.proxyUserKey.credentialName : "proxy-user-key";
      // Try the credential store first (provider-scoped), then process.env.
      const stored = await this.deps.credentialManager.getCredential(adapter.profile.id, credentialName).catch(() => undefined);
      if (stored) secrets[envVar] = stored;
      else if (process.env[envVar]) secrets[envVar] = process.env[envVar]!;
    }
    const mcpConfig = this.buildMcpConfig(adapter);
    return {
      workingDir,
      modelAlias,
      secrets,
      ...(resumeNativeSessionId ? { resumeNativeSessionId } : {}),
      ...(setSessionId ? { setSessionId } : {}),
      ...(taskPrompt ? { taskPrompt } : {}),
      ...(contextSystem ? { contextSystem } : {}),
      ...(mcpConfig ? { mcpConfig } : {}),
    };
  }

  /**
   * Secret-free MCP server config JSON for the profile's declared
   * `mcpLaunch` supply (Claude-family `--mcp-config <json>`). Reuses the
   * existing `continuum-mcp` stdio server command — no credential, no file
   * written, no unrelated MCP registrations touched. Returns undefined when
   * the profile doesn't supply MCP at launch (Codex reads global config).
   */
  private buildMcpConfig(adapter: ProviderAdapter): string | undefined {
    const launch = adapter.profile.cliLaunch;
    const mcp = launch.mcp;
    const supply = launch.mcpLaunch;
    if (!mcp || !mcp.supported || !supply || supply.kind !== "mcp-config-flag") return undefined;
    const [command, ...args] = mcpServerCommand();
    return JSON.stringify({
      mcpServers: { [mcp.serverName]: { type: "stdio", command, args } },
    });
  }

  private async detectProjectOrThrow(cwd?: string): Promise<import("../registry/types.js").ProjectRecord> {
    const dir = cwd ?? process.cwd();
    const detected = await this.deps.projects.detect(dir);
    if (!detected) throw new NoProjectError();
    return detected;
  }

  /**
   * Interactive provider selection for first-launch: offers the set of
   * providers that are both configured and authenticated. Never auto-selects:
   * a single available provider is still surfaced explicitly (returned only
   * when it's the sole option and confirmed by the caller is overkill here —
   * the prompt's answer is what resolves it).
   */
  private async promptForProvider(): Promise<string | undefined> {
    const available = await this.listAuthenticatedProviders();
    const ids = available.map((a) => a.providerId);
    if (ids.length === 0) return undefined;
    if (ids.length === 1) return ids[0];
    const choice = await this.deps.prompt.ask(`Choose a provider: [${ids.join("/")}]`);
    return ids.find((id) => id === choice.trim()) ?? ids[0];
  }
}
