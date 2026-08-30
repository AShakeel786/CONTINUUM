/**
 * Automatic provider-preference chain routing tests (GLM 5.2 Free → DeepSeek).
 *
 * The chain selects a provider ONLY when nothing explicit did: no --provider,
 * no resumed session, no explicit model selection, and the would-be automatic
 * candidate is undefined or itself a chain member. Every other path keeps the
 * pre-existing behavior. All credential checks run against an in-memory fake
 * backend — never the real OS credential store.
 *
 * Legacy identity: this provider was "Ox Alpha Free" (`ox-alpha`, wire model
 * `stealth/ox-alpha`) until OpenRouter retired it. The current identity is
 * `glm-5-2-free` ("GLM 5.2 Free (OpenRouter)", wire model `z-ai/glm-5.2:free`);
 * `ox-alpha` survives only as an id alias (plus a model alias for saved
 * `stealth/ox-alpha` preferences). Tests 5b and 12 pin the alias-compat
 * behavior — an old persisted id resolves, canonicalizes, and resumes without
 * a fake handoff.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Launcher, type LauncherDeps } from "../launcher.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { glm52FreeManifest } from "../../providers/presets.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { CredentialBackend, CliAuthAdapter } from "../../auth/types.js";
import type { ProviderProfile } from "../../providers/types.js";

const CC_BYPASS = "--dangerously-skip-permissions";
const GLM_WIRE = "z-ai/glm-5.2:free";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test backend";
  private readonly store = new Map<string, string>();
  async isAvailable() { return true; }
  async set(key: string, value: string) { this.store.set(key, value); }
  async get(key: string) { return this.store.get(key); }
  async delete(key: string) { this.store.delete(key); }
  async list() { return [...this.store.keys()]; }
}

function fakeCliAdapter(providerId: string): CliAuthAdapter {
  return {
    providerId,
    capability: claudeProfile.cliLaunch as never,
    async detectInstalled() { return "installed"; },
    async detectAuthenticated() { return "authenticated"; },
    async login() { return { completed: true, exitCode: 0 }; },
    async logout() { return { completed: true, exitCode: 0 }; },
  };
}

interface BuildOpts {
  readonly glmUsable?: boolean;
  readonly deepseekUsable?: boolean;
  readonly chain?: readonly string[];
  readonly glmProfile?: ProviderProfile;
  /** When set, overrides executable detection (claude present/absent) for deterministic harness selection. */
  readonly findExecutable?: (executable: string) => string | undefined;
}

async function buildDeps(opts: BuildOpts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-glmroute-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-glmroute-sess-"));
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(opts.glmProfile ?? manifestToProfile(glm52FreeManifest)));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  if (opts.deepseekUsable) await credentialManager.setCredential("deepseek", "api-key", "sk-ds-test");
  if (opts.glmUsable) await credentialManager.setCredential("glm-5-2-free", "api-key", "sk-glm-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));

  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const store = new FileSessionStore(sessionDir);
  const sessionManager = new SessionManager(store);

  const seedConfigDirFlag = vi.fn(async () => {});
  const seedConfigDirOnboarding = vi.fn(async () => {});
  const seedConfigDirProjectTrust = vi.fn(async () => {});
  const deps: LauncherDeps = {
    projects: registry,
    providers,
    credentialManager,
    cliAuthManager,
    authVerifier,
    authMetadata: createDefaultProviderAuthMetadata(),
    sessionManager,
    prompt: createScriptedPrompt({}),
    sessionBaseDir: sessionDir,
    // Keep these legacy GLM-routing tests isolated from additions to the
    // bundled default pool; Phase 2A covers the production chain in its own
    // focused launcher tests.
    preferredProviderChain: opts.chain ?? ["glm-5-2-free", "deepseek"],
    // Deterministic harness selection: claude present unless overridden.
    ...(opts.findExecutable ? { findExecutable: opts.findExecutable } : { findExecutable: (e: string) => (e === "claude" ? "/fake/claude" : undefined) }),
    // Stub the model-verify preflight: these routing tests assert the plan,
    // not the live OpenRouter catalog (model-verify.test.ts covers the real
    // preflight against a local catalog server).
    verifyWireModel: async () => undefined,
    // Never write the real home-dir settings.json in tests.
    seedConfigDirFlag,
    seedConfigDirOnboarding,
    seedConfigDirProjectTrust,
  };
  return { deps, registry, seedConfigDirFlag, seedConfigDirOnboarding, seedConfigDirProjectTrust };
}

async function projectWithDefault(defaultProvider?: string, defaultModel?: string) {
  const { deps, registry } = await buildDeps({ glmUsable: true, deepseekUsable: true });
  const p = await registry.add({
    name: `p-${Math.random().toString(36).slice(2, 8)}`,
    path: "/work/project",
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  });
  return { deps, project: p };
}

describe("automatic provider-preference chain (GLM 5.2 Free → DeepSeek)", () => {
  it("1. default-less project, glm usable → glm-5-2-free, chain-routed, Claude Code harness", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "hello" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("glm-5-2-free");
    expect(prep.providerRef.model).toBe(GLM_WIRE);
    expect(prep.autoRoute).toEqual({ chain: ["glm-5-2-free", "deepseek"], index: 0 });
    expect(prep.runtimeKind).toBe("cli");
    expect(prep.plan.executable).toBe("claude");
    expect(prep.plan.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(prep.modelDecision.automatic).toBe(true);
    expect(prep.modelDecision.reason).toContain("automatic-preference");
  });

  it("1b. without the claude executable, glm falls back to the direct API harness (still chain-routed)", async () => {
    const { deps, registry } = await buildDeps({ glmUsable: true, deepseekUsable: true, findExecutable: () => undefined });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "hello" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("glm-5-2-free");
    expect(prep.autoRoute?.index).toBe(0);
    expect(prep.runtimeKind).toBe("api");
  });

  it("2. deepseek-default project, glm unusable → deepseek stays; existing reason preserved", async () => {
    const { deps, registry } = await buildDeps({ deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ds", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.providerRef.model).toBe("deepseek-v4-flash");
    expect(prep.autoRoute).toEqual({ chain: ["glm-5-2-free", "deepseek"], index: 1 });
    expect(prep.modelDecision.reason).toContain("automatic-default-flash");
  });

  it("3. default-less project reaches paid DeepSeek only with explicit opt-in", async () => {
    const { deps, registry } = await buildDeps({ deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe", allowPaidFallback: true });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.autoRoute?.index).toBe(1);
    expect(prep.modelDecision.reason).toContain("automatic-preference: no default provider → deepseek");
  });

  it("3b. default-less project never auto-selects paid when the free pool is unavailable", async () => {
    const { deps, registry } = await buildDeps({ deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const prep = await new Launcher(deps).prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("claude");
    expect(prep.autoRoute).toBeUndefined();
  });

  it("4. expired promo → glm skipped by the chain, but still explicitly selectable", async () => {
    const expired = manifestToProfile({ ...glm52FreeManifest, promo: { until: "2000-01-01T00:00:00Z", note: "expired" } });
    const { deps, registry } = await buildDeps({ glmUsable: true, deepseekUsable: true, glmProfile: expired });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const auto = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe", allowPaidFallback: true });
    expect(auto.providerRef.providerId).toBe("deepseek");
    const explicit = await launcher.prepareLaunch({ projectKey: p.id, providerId: "glm-5-2-free", taskGoal: "x" }, { permissionMode: "safe" });
    expect(explicit.providerRef.providerId).toBe("glm-5-2-free");
    expect(explicit.autoRoute).toBeUndefined();
  });

  it("5. explicit --provider selection is never chain-routed", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, providerId: "deepseek", taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.autoRoute).toBeUndefined();
  });

  it("5b. an explicit legacy ox-alpha selection canonicalizes to glm-5-2-free (never silently dropped)", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, providerId: "ox-alpha", taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("glm-5-2-free");
    expect(prep.providerRef.model).toBe(GLM_WIRE);
    expect(prep.runtimeKind).toBe("cli");
    expect(prep.autoRoute).toBeUndefined();
  });

  it("5c. glm bypass mode emits the verified Claude Code flag; safe mode does not", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const bypass = await launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "x" }, { permissionMode: "bypass" });
    expect(bypass.plan.bypassPermissions).toBe(true);
    expect(bypass.plan.args).toContain(CC_BYPASS);
    const safe = await launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "x" }, { permissionMode: "safe" });
    expect(safe.plan.bypassPermissions).toBe(false);
    expect(safe.plan.args).not.toContain("--dangerously");
  });

  it("5d. glm ALWAYS launches with the bypass flag by default (fresh + resume), no explicit opt-in needed", async () => {
    const { deps, registry, seedConfigDirFlag, seedConfigDirOnboarding, seedConfigDirProjectTrust } = await buildDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    // Fresh launch, no permission options at all → descriptor default = bypass.
    const fresh = await launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "x" }, {});
    expect(fresh.providerRef.model).toBe(GLM_WIRE); // wire model, no claude id
    expect(fresh.plan.bypassPermissions).toBe(true);
    expect(fresh.plan.args[0]).toBe(CC_BYPASS); // bypass first, like Claude/DeepSeek redirected
    expect(fresh.plan.args.filter((a) => a === CC_BYPASS)).toHaveLength(1); // exactly once
    expect(fresh.plan.args).toContain("--session-id"); // Claude-family session handling
    expect(fresh.plan.args).not.toContain("--conversation"); // agy-ism never leaks in
    expect(fresh.plan.args.some((a) => a === "--model" || a.startsWith("--model="))).toBe(false); // no gemini model flag
    // The one-time bypass confirmation is pre-accepted inside the isolated
    // GLM Free config dir (legacy .claude-oxalpha name kept for resume compat).
    expect(seedConfigDirFlag).toHaveBeenCalledWith(expect.stringContaining(".claude-oxalpha"), "skipDangerousModePermissionPrompt", true);
    expect(seedConfigDirOnboarding).toHaveBeenCalledWith(expect.stringContaining(".claude-oxalpha"));
    expect(seedConfigDirProjectTrust).toHaveBeenCalledWith(expect.stringContaining(".claude-oxalpha"), resolve("/work/x"));
    // Resume with no permission options → bypass retained, Claude-family resume.
    const resumed = await launcher.prepareLaunch({ sessionId: fresh.session!.sessionId }, {});
    expect(resumed.providerRef.providerId).toBe("glm-5-2-free");
    expect(resumed.providerRef.model).toBe(GLM_WIRE);
    expect(resumed.plan.bypassPermissions).toBe(true);
    expect(resumed.plan.args.slice(0, 3)).toEqual([CC_BYPASS, "--resume", fresh.session!.sessionId]);
    expect(resumed.plan.args.filter((a) => a === CC_BYPASS)).toHaveLength(1);
    expect(resumed.plan.args).not.toContain("--conversation");
    expect(resumed.plan.args.some((a) => a === "--model" || a.startsWith("--model="))).toBe(false);
  });

  it("5e. the direct API fallback harness never emits CLI permission flags", async () => {
    const { deps, registry, seedConfigDirFlag, seedConfigDirOnboarding, seedConfigDirProjectTrust } = await buildDeps({ glmUsable: true, findExecutable: () => undefined });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, providerId: "glm-5-2-free", taskGoal: "x" }, {});
    expect(prep.runtimeKind).toBe("api");
    expect(prep.plan.bypassPermissions).toBe(false);
    expect(prep.plan.args).not.toContain("--dangerously-skip-permissions");
    expect(seedConfigDirFlag).not.toHaveBeenCalled();
    expect(seedConfigDirProjectTrust).not.toHaveBeenCalled();
    expect(seedConfigDirOnboarding).not.toHaveBeenCalled();
  });

  it("5f. DeepSeek and native Claude ALSO default to the bypass flag (global bypass default)", async () => {
    const { deps, registry, seedConfigDirFlag } = await buildDeps({ deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ds", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const ds = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, {});
    expect(ds.plan.bypassPermissions).toBe(true);
    expect(ds.plan.args).toContain("--dangerously-skip-permissions");
    const claudeP = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/c", defaultProvider: "claude" });
    const cc = await launcher.prepareLaunch({ projectKey: claudeP.id, taskGoal: "x" }, {});
    expect(cc.plan.bypassPermissions).toBe(true);
    expect(cc.plan.args).toContain("--dangerously-skip-permissions");
    // The one-time bypass confirmation is pre-accepted inside each provider's
    // isolated config dir (never the user's global settings).
    expect(seedConfigDirFlag).toHaveBeenCalledWith(expect.stringContaining(".claude-deepseek"), "skipDangerousModePermissionPrompt", true);
    expect(seedConfigDirFlag).toHaveBeenCalledWith(expect.stringContaining(".claude-anthropic"), "skipDangerousModePermissionPrompt", true);
  });

  it("6. explicit --model selection is never chain-routed", async () => {
    const { deps, registry } = await buildDeps({ glmUsable: true, deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ds", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, modelAlias: "flash", taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.providerRef.model).toBe("deepseek-v4-flash");
    expect(prep.autoRoute).toBeUndefined();
  });

  it("7. resume keeps the session's active provider — never chain-routed", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "first" }, { permissionMode: "safe" });
    expect(first.providerRef.providerId).toBe("glm-5-2-free");
    const resumed = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(resumed.providerRef.providerId).toBe("glm-5-2-free");
    expect(resumed.autoRoute).toBeUndefined();
  });

  it("8. a non-chain project default (claude) is never chain-routed", async () => {
    const { deps, registry } = await buildDeps({ glmUsable: true, deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/c", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("claude");
    expect(prep.autoRoute).toBeUndefined();
  });

  it("9. an injected chain skips unknown ids and picks the first usable member", async () => {
    const { deps, registry } = await buildDeps({ deepseekUsable: true, chain: ["ghost", "deepseek"] });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe", allowPaidFallback: true });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.autoRoute).toEqual({ chain: ["ghost", "deepseek"], index: 1 });
  });

  it("10. deepseek-default project upgrades to glm while glm is usable", async () => {
    const { deps, registry } = await buildDeps({ glmUsable: true, deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ds", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("glm-5-2-free");
    expect(prep.autoRoute?.index).toBe(0);
    expect(prep.modelDecision.reason).toContain("automatic-preference: deepseek default → glm-5-2-free");
  });

  it("11. when no chain member is usable, the existing interactive prompt path is preserved", async () => {
    // Only claude is usable here (fake CLI auth adapter); no glm/deepseek credentials.
    const { deps, registry } = await buildDeps({});
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/c" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("claude");
    expect(prep.autoRoute).toBeUndefined();
    expect(prep.modelDecision.reason).toBe("provider default");
  });

  it("12. a legacy ox-alpha session resumes as glm-5-2-free: canonicalized, native-resumed via the id alias, no fake handoff", async () => {
    // Seed an old persisted session exactly as a pre-rename install wrote it:
    // activeProvider under the legacy id + model alias, native id under the
    // legacy provider key, project already registered.
    const { deps, registry } = await buildDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const legacyId = "legacy-ox-session";
    await deps.sessionManager.createSession({
      sessionId: legacyId,
      mode: "project",
      projectId: project.id,
      workingDirectory: "/work/x",
      activeProvider: { providerId: "ox-alpha", model: "stealth/ox-alpha" },
      taskGoal: "legacy task",
    });
    await deps.sessionManager.recordNativeSessionId(legacyId, "ox-alpha", "native-old");

    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ sessionId: legacyId, taskGoal: "continue legacy task" }, {});
    // Resolved to the canonical identity on the wire.
    expect(prep.providerRef.providerId).toBe("glm-5-2-free");
    expect(prep.providerRef.model).toBe(GLM_WIRE);
    // The persisted session record was migrated to the canonical id.
    expect(prep.session!.activeProvider.providerId).toBe("glm-5-2-free");
    expect(prep.session!.activeProvider.model).toBe(GLM_WIRE);
    // The native session persisted under the legacy provider key is found via
    // the id alias, so the user resumes the real native conversation.
    expect(prep.plan.args).toContain("--resume");
    expect(prep.plan.args).toContain("native-old");
    // An alias resume is NOT a provider change → no fake handoff was recorded.
    expect(prep.session!.lastHandoff).toBeUndefined();
  });
});
