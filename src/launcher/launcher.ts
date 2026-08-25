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
import { basename } from "node:path";
import { dirname } from "node:path";
import type { ProjectRegistry } from "../registry/registry.js";
import type { ProjectRecord } from "../registry/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { LaunchRoute, ProviderAdapter, ProviderProfile } from "../providers/types.js";
import type { DiscoveredModel } from "../providers/model-discovery.js";
import { discoverModelsFor } from "../providers/model-discovery.js";
import { isPromoActive } from "../providers/promo.js";
import { DEFAULT_PROVIDER_PREFERENCE_CHAIN } from "../providers/presets.js";
import type { CredentialManager } from "../auth/credential-manager.js";
import type { CliAuthManager } from "../auth/cli-auth-manager.js";
import type { AuthVerifier } from "../auth/auth-verifier.js";
import type { ProviderAuthMetadata } from "../auth/types.js";
import type { SessionManager } from "../session/manager.js";
import type { ProviderRef, SessionMode, TaskSession } from "../session/types.js";
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
import { LocalDependencyUnavailableError, NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "./errors.js";
import type { ProxyReadiness } from "../health/launch-guard.js";
import { computeProviderUsability, type ProviderUsability } from "./usability.js";
import type { LaunchOptions, LaunchPlan, LaunchPreparation } from "./types.js";
import { DEFAULT_ROLLOVER_POLICY, evaluateRollover } from "../cost/calculator.js";
import { nativeSessionFile, readClaudeUsage } from "../cost/native-usage.js";
import { createRolloverHandoff } from "../cost/rollover.js";

export type { ProviderUsability } from "./usability.js";

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
  /**
   * Optional local-dependency readiness/self-heal gate for proxy-routed
   * launches (the Tencent MemoryProxy — see health/launch-guard.ts). When
   * absent, proxy-routed launches proceed unchecked (prior behavior) — this
   * only tightens an existing gap, it never becomes a hard requirement.
   */
  readonly ensureProxyReady?: (proxyBaseUrl: string, onProgress?: (line: string) => void) => Promise<ProxyReadiness>;
  /** Progress lines from `ensureProxyReady` (see above) — stateful, not raw retry spam. */
  readonly onDependencyProgress?: (line: string) => void;
  /**
   * Resolve which launch route a dual-route provider (DeepSeek) uses this run.
   * Absent (or returning anything but "proxy") = direct standalone launch.
   * Defaults to "direct" — the optional Tencent proxy is never inferred.
   */
  readonly getProviderRoute?: (providerId: string) => LaunchRoute;
  /**
   * Live model-list discovery (test seam + best-effort override). Defaults to
   * `discoverModelsFor`, which runs the installed CLI's declared discovery
   * mechanism. A failure degrades to manifest models, never errors.
   */
  readonly discoverModels?: (profile: ProviderProfile) => Promise<readonly DiscoveredModel[]>;
  /**
   * Automatic provider-preference chain (overridable in tests). When a launch
   * carries no explicit provider/model selection, the launcher walks this
   * list and picks the first usable member. Defaults to the bundled
   * `DEFAULT_PROVIDER_PREFERENCE_CHAIN` (Ox Alpha Free → DeepSeek).
   */
  readonly preferredProviderChain?: readonly string[];
}

export type SpawnFn = (plan: LaunchPlan) => Promise<{ exitCode: number | null }>;

const DEFAULT_OUTPUT_RESERVE = 8192;
const REPO_MAP_BUDGET_TOKENS = 1200;

/**
 * Synthetic, never-persisted `ProjectRecord` ids for no-project launches.
 * These never touch `ProjectRegistry` — they only satisfy the internal
 * plumbing (`LaunchPlan.workingDir`, repo-map, scope provider) that already
 * expects a `ProjectRecord`-shaped anchor, so no parallel launch path is
 * needed for general/current-directory sessions.
 */
const GENERAL_PROJECT_ID = "__continuum-general__";
const CURRENT_DIRECTORY_PROJECT_ID = "__continuum-current-directory__";

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
        route: this.routeFor(id),
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

  private routeFor(providerId: string): LaunchRoute {
    return this.deps.getProviderRoute?.(providerId) ?? "direct";
  }

  private async isProviderUsable(
    adapter: ProviderAdapter,
    metadata: ProviderAuthMetadata,
  ): Promise<{ usable: boolean; reason?: string }> {
    return computeProviderUsability(adapter, metadata, {
      cliAuthManager: this.deps.cliAuthManager,
      credentialManager: this.deps.credentialManager,
      route: this.routeFor(adapter.profile.id),
    });
  }

  /**
   * Prepares (but does NOT execute) a launch: resolves project/provider,
   * verifies usability, builds the launch plan + context, and returns
   * everything for the caller to inspect and/or spawn. Safe-by-default.
   */
  async prepareLaunch(
    target: { projectKey?: string; cwd?: string; providerId?: string; modelAlias?: string; taskGoal?: string; sessionId?: string; mode?: "general" | "current-directory" },
    opts: LaunchOptions,
  ): Promise<LaunchPreparation> {
    // Resume path: the session already knows its project + active provider.
    const existingSession = target.sessionId
      ? await this.deps.sessionManager.loadSession(target.sessionId)
      : undefined;

    // Session mode resolution: a resumed session's own `mode` is authoritative
    // (a caller's `target.mode` never overrides an existing session's anchor).
    // Otherwise an explicit `target.mode` requests a no-project launch; absent
    // both, this is the existing project-resolution path, unchanged.
    const sessionMode: SessionMode = existingSession ? existingSession.mode : target.mode ?? "project";

    const project: ProjectRecord =
      sessionMode !== "project"
        ? this.buildVirtualProject(sessionMode, existingSession ? existingSession.workingDirectory : target.cwd ?? process.cwd())
        : target.projectKey
          ? await this.deps.projects.resolve(target.projectKey)
          : existingSession
            ? await this.deps.projects.resolve(existingSession.projectId!)
            : await this.detectProjectOrThrow(target.cwd);

    // Resume: keep the session's active provider unless an explicit override
    // is given (e.g. a handoff to a different agent).
    let providerId =
      target.providerId ??
      existingSession?.activeProvider.providerId ??
      project.defaultProvider;

    // Automatic provider-preference chain (Ox Alpha Free → DeepSeek).
    // Consulted ONLY when nothing explicit selected the provider: no
    // `--provider`, no resumed session (its active provider is explicit
    // state), no explicit model selection (`--model` / project defaultModel),
    // and the would-be automatic candidate is undefined or itself a chain
    // member (so a DeepSeek-default project upgrades to Ox while the promo
    // is active; non-chain defaults like Claude are never touched). An
    // explicit user/provider/model selection always overrides this chain.
    let autoRoute: { chain: readonly string[]; index: number } | undefined;
    const preferredChain = this.preferredChain;
    if (
      !target.providerId &&
      !existingSession &&
      target.modelAlias === undefined &&
      project.defaultModel === undefined &&
      (providerId === undefined || preferredChain.includes(providerId))
    ) {
      const picked = await this.pickPreferredProvider();
      if (picked) {
        providerId = picked.providerId;
        autoRoute = { chain: preferredChain, index: picked.index };
      }
    }

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

    // The effective launch route for this run (direct default; proxy only when
    // explicitly configured). Used below for the dependency gate and the plan.
    const route = this.routeFor(providerId);

    // Local-dependency readiness (Tencent MemoryProxy): a proxy-routed launch
    // is doomed before it starts if the proxy isn't reachable — the provider
    // CLI would spawn straight into its own uncontrolled connection-refused
    // retry loop, which CONTINUUM can neither see nor stop. Check + bounded
    // self-heal HERE, before any session is created or mutated below, so a
    // failure never disturbs existing session/handoff state and a retry
    // after fixing the dependency resumes cleanly. Direct (redirected/native)
    // launches never engage this gate.
    const effectiveLaunch = adapter.resolveCliLaunch(route);
    if (effectiveLaunch.kind === "proxy-routed" && this.deps.ensureProxyReady) {
      const readiness = await this.deps.ensureProxyReady(effectiveLaunch.proxyBaseUrl, this.deps.onDependencyProgress);
      if (!readiness.ready) {
        throw new LocalDependencyUnavailableError(providerId, effectiveLaunch.proxyBaseUrl, sessionMode, readiness.detail, readiness.repairAttempted);
      }
    }

    // Permission mode: explicit caller choice wins; otherwise the provider's
    // declared default applies (Codex/Antigravity default to full access,
    // Claude/DeepSeek default to safe). Full access is honored ONLY when the
    // launch descriptor declares a real native bypass flag — a requested
    // bypass with no flag is surfaced as a visible note, never silently run.
    const requestedPermission = opts.permissionMode ?? adapter.profile.defaultPermissionMode ?? "safe";
    const canBypass = effectiveLaunch.kind === "native" && !!effectiveLaunch.permissionBypassFlag;
    const bypassPermissions = requestedPermission === "bypass" && canBypass;
    const permissionNote =
      requestedPermission === "bypass" && !canBypass
        ? `${providerId} declares no native full-access flag — launching in normal approval mode.`
        : undefined;

    // DeepSeek is Flash-by-default. Only a direct CLI model override, an
    // explicitly saved project default, or an explicitly user-selected model
    // on this logical session may select Pro. Legacy activeProvider.model is
    // deliberately not treated as consent to continue Pro.
    const sessionModelPreference =
      existingSession && !target.modelAlias && project.defaultModel === undefined && existingSession.modelPreference?.source === "user"
        ? existingSession.modelPreference.model
        : undefined;
    const requestedModel = target.modelAlias ?? project.defaultModel ?? sessionModelPreference;

    // Discovery-aware model resolution. For providers with live model
    // discovery (Codex/Antigravity), an explicitly selected model is resolved
    // against the installed CLI's CURRENT list: a live model id passes through
    // verbatim (never remapped or dropped), and a saved model that disappeared
    // after a CLI update falls back to the provider default with explicit
    // visible messaging — never silently.
    let model: string;
    let modelNote: string | undefined;
    let knownModelIds: ReadonlySet<string> | undefined;
    if (requestedModel === undefined) {
      model = adapter.resolveModel();
    } else {
      let discovered: readonly DiscoveredModel[] = [];
      if (adapter.profile.modelDiscovery) {
        try {
          discovered = await this.discoverModels(adapter.profile);
          knownModelIds = new Set(discovered.map((m) => m.id));
        } catch {
          discovered = []; // discovery failed → proceed unvalidated
        }
      }
      model = adapter.resolveModel(requestedModel, knownModelIds);
      if (discovered.length > 0 && !discovered.some((m) => m.id === model)) {
        modelNote = `Selected model "${model}" is not in the current ${providerId} model list (the CLI may have updated). Falling back to ${adapter.resolveModel()}.`;
        model = adapter.resolveModel();
      }
    }
    const providerRef: ProviderRef = { providerId, model };
    const modelDecision = {
      automatic: requestedModel === undefined,
      reason: ((): string => {
        if (requestedModel !== undefined) {
          return `explicit ${target.modelAlias ? "user" : project.defaultModel ? "project" : "session"} model selection: ${requestedModel}`;
        }
        if (opts.autoFallbackFrom) {
          return `automatic-fallback: ${opts.autoFallbackFrom} → ${providerId}`;
        }
        if (autoRoute) {
          // Chain kept the would-be automatic candidate — preserve the exact
          // existing reason strings (asserted by deepseek-routing tests).
          if (providerId === project.defaultProvider) {
            return providerId === "deepseek"
              ? "automatic-default-flash: no explicit user/project/session model preference"
              : "provider default";
          }
          const promoNote = providerId === "ox-alpha" ? " (limited-time free promo)" : "";
          return project.defaultProvider
            ? `automatic-preference: ${project.defaultProvider} default → ${providerId}${promoNote}`
            : `automatic-preference: no default provider → ${providerId}${promoNote}`;
        }
        return providerId === "deepseek"
          ? "automatic-default-flash: no explicit user/project/session model preference"
          : "provider default";
      })(),
    };

    // Session identity: resume an existing session, or create a new one.
    let session: TaskSession | undefined;
    let stale = false;
    let staleReasons: readonly string[] = [];
    // "general" sessions have no fixed repo anchor — skip fingerprinting so a
    // free-roaming session is never flagged stale against an arbitrary cwd.
    const currentGit = sessionMode === "general" ? undefined : await captureGitFingerprint(project.path);

    if (existingSession) {
      session = existingSession;
      // Bump last-active on resume so the resume picker sorts by "most recently
      // worked on". Provider-change resumes already refresh `updatedAt` via
      // setActiveProvider below, so only touch the common same-provider path.
      const providerChanging = !!target.providerId && target.providerId !== session.activeProvider.providerId;
      if (!providerChanging) {
        await this.deps.sessionManager.markActive(session.sessionId).catch(() => {});
      }
      if (session.git && currentGit) {
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
      if (target.modelAlias || project.defaultModel) {
        session = await this.deps.sessionManager.setModelPreference(session.sessionId, {
          model,
          source: target.modelAlias ? "user" : "project",
        });
      }
    } else {
      const goal = target.taskGoal ?? "(untitled)";
      session = await this.deps.sessionManager.createSession({
        sessionId: randomUUID(),
        ...(sessionMode === "project" ? { projectId: project.id } : {}),
        mode: sessionMode,
        workingDirectory: project.path,
        activeProvider: providerRef,
        // An explicitly-selected model (user alias or project default) is the
        // durable "saved model" a resume should honor — recorded for every
        // provider, read back on resume via `sessionModelPreference` above.
        ...(requestedModel !== undefined
          ? { modelPreference: { model, source: target.modelAlias ? "user" as const : "project" as const } }
          : {}),
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
    let resumeNativeSessionId = sameProviderResume ? session.nativeSessionIds?.[providerId] : undefined;
    let rollover: LaunchPreparation["rollover"];
    if (resumeNativeSessionId && providerId === "deepseek") {
      const native = effectiveLaunch.nativeResume;
      if (native?.supported) {
        const file = await nativeSessionFile(native.sessionStore, resumeNativeSessionId);
        if (file) {
          const usage = await readClaudeUsage(file);
          const mode = process.env.CONTINUUM_ROLLOVER_MODE as "automatic" | "tokens" | "off" | undefined;
          const threshold = Number(process.env.CONTINUUM_ROLLOVER_TOKENS ?? DEFAULT_ROLLOVER_POLICY.contextTokenThreshold);
          const policy = { ...DEFAULT_ROLLOVER_POLICY, ...(mode ? { mode } : {}), ...(Number.isFinite(threshold) ? { contextTokenThreshold: threshold } : {}) };
          const decision = evaluateRollover(usage, model, policy);
          if (decision.rollover) {
            const oldId = resumeNativeSessionId;
            const nextId = randomUUID();
            const handoff = await createRolloverHandoff(dirname(this.deps.sessionBaseDir), session, decision.reason);
            session = await this.deps.sessionManager.recordRollover(session.sessionId, {
              rolloverId: handoff.rolloverId, at: new Date().toISOString(), providerId, fromNativeSessionId: oldId,
              toNativeSessionId: nextId, handoffFile: handoff.file, reason: decision.reason, estimatedCostAvoidedUsd: decision.estimatedAvoidedUsd,
            });
            resumeNativeSessionId = undefined;
            rollover = { fromNativeSessionId: oldId, toNativeSessionId: nextId, handoffFile: handoff.file, reason: decision.reason, estimatedCostAvoidedUsd: decision.estimatedAvoidedUsd };
          }
        }
      }
    }

    // Deterministic native session id: when NOT resuming and the provider
    // declares a session-id flag (Claude/DeepSeek), set the native id equal to
    // the CONTINUUM session id up front — no newest-file discovery needed.
    // Codex declares no flag, so it keeps the store-scan fallback.
    let setSessionId: string | undefined;
    if (!resumeNativeSessionId) {
      const nr = adapter.profile.cliLaunch.nativeResume;
      if (nr?.supported && nr.sessionIdFlag) {
        setSessionId = rollover?.toNativeSessionId ?? session.sessionId;
        await this.deps.sessionManager.recordNativeSessionId(session.sessionId, providerId, setSessionId).catch(() => {});
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
    if (this.deps.repoMapBuilder && sessionMode !== "general") {
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
          memoryRelevance: { query: session.taskGoal, projectName: project.name },
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
    // The launch secret (deepseek api-key in direct mode, proxy user key in
    // proxy mode) is sourced from the credential backend, not a manual env var —
    // see ctx.secrets below.
    // `model` (not the raw `requestedModel` alias) is what reaches the CLI: an
    // alias like `flash` is resolved to its id, and a vanished saved model is
    // already replaced by the provider default above — never a stale id.
    const launchCtx = await this.buildLaunchContext(adapter, metadata, model, project.path, resumeNativeSessionId, setSessionId, taskPrompt, contextSystem, route, bypassPermissions ? "bypass" : "safe", knownModelIds);
    const basePlan = adapter.buildCliLaunchPlan(launchCtx);
    const authEnv = metadata.api.supported ? await this.resolveAuthEnvSafely(adapter, metadata, route) : {};

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
      bypassPermissions,
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
      contextWindowTokens: contextWindow,
      contextTokensUsed: budget.inputTokensAfter.tokens,
      route,
      modelDecision,
      ...(autoRoute ? { autoRoute } : {}),
      ...(modelNote ? { modelNote } : {}),
      ...(permissionNote ? { permissionNote } : {}),
      ...(rollover ? { rollover } : {}),
      ...(resumeNativeSessionId ? { nativeResume: { providerId, nativeSessionId: resumeNativeSessionId } } : {}),
    };
  }

  /** Live model-list discovery — test seam in `LauncherDeps`, else the profile's declared mechanism. */
  private discoverModels(profile: ProviderProfile): Promise<readonly DiscoveredModel[]> {
    if (this.deps.discoverModels) return this.deps.discoverModels(profile);
    return discoverModelsFor(profile);
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

  private async resolveAuthEnvSafely(adapter: ProviderAdapter, metadata: ProviderAuthMetadata, route: LaunchRoute): Promise<Record<string, string>> {
    // Only API-key/bearer auth has an env var to populate; cli-session providers
    // rely on their own login and inject nothing.
    const envVar = metadata.api.supported ? metadata.api.envVar : undefined;
    if (!envVar) return {};
    // Redirected and proxy-routed launches do NOT inject the raw upstream API
    // key as a plain env var: the adapter already carries it as
    // ANTHROPIC_AUTH_TOKEN (redirected) or the proxy holds it server-side
    // (proxy-routed). Injecting DEEPSEEK_API_KEY/ANTHROPIC_API_KEY here would
    // leak it into the child env unnecessarily. Only a native direct-API call
    // needs the raw var.
    if (adapter.resolveCliLaunch(route).kind !== "native") return {};
    try {
      return await resolveProviderAuthEnv(adapter, this.deps.credentialManager);
    } catch {
      return {};
    }
  }

  /**
   * Builds the `CliLaunchContext` for a provider, resolving any launch secret
   * (the deepseek api-key in direct mode, or the proxy user key in proxy mode)
   * from the credential backend into `ctx.secrets`, so `buildCliLaunchPlan`
   * never depends on a manual env var. Falls back to `process.env` for any
   * secret not in the store (which keeps backward compatibility with an
   * explicitly-exported key).
   */
  private async buildLaunchContext(adapter: ProviderAdapter, metadata: ProviderAuthMetadata, modelAlias: string | undefined, workingDir: string, resumeNativeSessionId: string | undefined, setSessionId: string | undefined, taskPrompt: string | undefined, contextSystem: string | undefined, route: LaunchRoute, permissionMode: "safe" | "bypass", knownModelIds: ReadonlySet<string> | undefined): Promise<import("../providers/types.js").CliLaunchContext> {
    const secrets: Record<string, string> = {};
    const launch = adapter.resolveCliLaunch(route);
    if (launch.kind === "redirected") {
      // Direct DeepSeek: resolve the upstream API key (stored as "api-key")
      // into the descriptor's auth-token env var.
      const envVar = launch.authTokenSecret.envVar;
      if (envVar === undefined) throw new Error("redirected provider profile is missing authTokenSecret.envVar");
      const stored = await this.deps.credentialManager.getCredential(adapter.profile.id, "api-key").catch(() => undefined);
      if (stored) secrets[envVar] = stored;
      else if (process.env[envVar]) secrets[envVar] = process.env[envVar]!;
    } else if (launch.kind === "proxy-routed") {
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
      route,
      permissionMode,
      ...(knownModelIds ? { knownModelIds } : {}),
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

  private async detectProjectOrThrow(cwd?: string): Promise<ProjectRecord> {
    const dir = cwd ?? process.cwd();
    const detected = await this.deps.projects.detect(dir);
    if (!detected) throw new NoProjectError();
    return detected;
  }

  /**
   * A `ProjectRecord`-shaped stand-in for general/current-directory launches —
   * never written to `ProjectRegistry`. Exists only so the rest of
   * `prepareLaunch` (and `LaunchPlan.workingDir`/repo-map/scope-provider,
   * which all key off `ProjectRecord.path`) needs no parallel code path for
   * "no project" launches.
   */
  private buildVirtualProject(mode: "general" | "current-directory", dir: string): ProjectRecord {
    const timestamp = new Date().toISOString();
    return {
      id: mode === "general" ? GENERAL_PROJECT_ID : CURRENT_DIRECTORY_PROJECT_ID,
      name: mode === "general" ? "General (no project)" : `Current directory (${basename(dir)})`,
      path: dir,
      aliases: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private get preferredChain(): readonly string[] {
    return this.deps.preferredProviderChain ?? DEFAULT_PROVIDER_PREFERENCE_CHAIN;
  }

  /**
   * Walk the automatic provider-preference chain and return the first
   * registered, promo-active, usable member — or undefined, in which case the
   * caller keeps today's prompt/error behavior. Unregistered ids are skipped
   * (test registries keep working), as are providers whose promo has expired
   * (an expired promo is no longer auto-preferred, only explicitly selectable).
   */
  private async pickPreferredProvider(): Promise<{ providerId: string; index: number } | undefined> {
    const chain = this.preferredChain;
    for (let i = 0; i < chain.length; i++) {
      const id = chain[i]!;
      if (!this.deps.providers.has(id)) continue;
      const adapter = this.deps.providers.get(id);
      const promo = adapter.profile.promo;
      if (promo && !isPromoActive(promo)) continue;
      const metadata = this.deps.authMetadata.get(id);
      if (!metadata) continue;
      const usable = await this.isProviderUsable(adapter, metadata);
      if (usable.usable) return { providerId: id, index: i };
    }
    return undefined;
  }

  /**
   * Public usability probe for a single provider — the seam `launchPrepared`
   * uses to find the next usable automatic-fallback candidate after a runtime
   * failure. Callers guard with `providers.has(id)` first.
   */
  async providerUsability(providerId: string): Promise<{ usable: boolean; reason?: string }> {
    const adapter = this.deps.providers.get(providerId);
    const metadata = this.deps.authMetadata.get(providerId);
    if (!metadata) return { usable: false, reason: "no auth metadata registered" };
    return this.isProviderUsable(adapter, metadata);
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
