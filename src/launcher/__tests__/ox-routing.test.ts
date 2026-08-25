/**
 * Automatic provider-preference chain routing tests (Ox Alpha Free → DeepSeek).
 *
 * The chain selects a provider ONLY when nothing explicit did: no --provider,
 * no resumed session, no explicit model selection, and the would-be automatic
 * candidate is undefined or itself a chain member. Every other path keeps the
 * pre-existing behavior. All credential checks run against an in-memory fake
 * backend — never the real OS credential store.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, type LauncherDeps } from "../launcher.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { oxAlphaManifest } from "../../providers/presets.js";
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
  readonly oxUsable?: boolean;
  readonly deepseekUsable?: boolean;
  readonly chain?: readonly string[];
  readonly oxProfile?: ProviderProfile;
  /** When set, overrides executable detection (claude present/absent) for deterministic harness selection. */
  readonly findExecutable?: (executable: string) => string | undefined;
}

async function buildDeps(opts: BuildOpts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-oxroute-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-oxroute-sess-"));
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(opts.oxProfile ?? manifestToProfile(oxAlphaManifest)));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  if (opts.deepseekUsable) await credentialManager.setCredential("deepseek", "api-key", "sk-ds-test");
  if (opts.oxUsable) await credentialManager.setCredential("ox-alpha", "api-key", "sk-ox-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));

  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const store = new FileSessionStore(sessionDir);
  const sessionManager = new SessionManager(store);

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
    ...(opts.chain ? { preferredProviderChain: opts.chain } : {}),
    // Deterministic harness selection: claude present unless overridden.
    ...(opts.findExecutable ? { findExecutable: opts.findExecutable } : { findExecutable: (e: string) => (e === "claude" ? "/fake/claude" : undefined) }),
  };
  return { deps, registry };
}

async function projectWithDefault(defaultProvider?: string, defaultModel?: string) {
  const { deps, registry } = await buildDeps({ oxUsable: true, deepseekUsable: true });
  const p = await registry.add({
    name: `p-${Math.random().toString(36).slice(2, 8)}`,
    path: "/work/project",
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  });
  return { deps, project: p };
}

describe("automatic provider-preference chain (Ox Alpha Free → DeepSeek)", () => {
  it("1. default-less project, ox usable → ox-alpha, chain-routed, Claude Code harness, promo reason", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "hello" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("ox-alpha");
    expect(prep.providerRef.model).toBe("stealth/ox-alpha");
    expect(prep.autoRoute).toEqual({ chain: ["ox-alpha", "deepseek"], index: 0 });
    expect(prep.runtimeKind).toBe("cli");
    expect(prep.plan.executable).toBe("claude");
    expect(prep.plan.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(prep.modelDecision.automatic).toBe(true);
    expect(prep.modelDecision.reason).toContain("automatic-preference");
    expect(prep.modelDecision.reason).toContain("limited-time free promo");
  });

  it("1b. without the claude executable, ox falls back to the direct API harness (still chain-routed)", async () => {
    const { deps, registry } = await buildDeps({ oxUsable: true, deepseekUsable: true, findExecutable: () => undefined });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "hello" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("ox-alpha");
    expect(prep.autoRoute?.index).toBe(0);
    expect(prep.runtimeKind).toBe("api");
  });

  it("2. deepseek-default project, ox unusable → deepseek stays; existing reason preserved", async () => {
    const { deps, registry } = await buildDeps({ deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ds", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.providerRef.model).toBe("deepseek-v4-flash");
    expect(prep.autoRoute).toEqual({ chain: ["ox-alpha", "deepseek"], index: 1 });
    expect(prep.modelDecision.reason).toContain("automatic-default-flash");
  });

  it("3. default-less project, ox unusable → deepseek via chain", async () => {
    const { deps, registry } = await buildDeps({ deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.autoRoute?.index).toBe(1);
    expect(prep.modelDecision.reason).toContain("automatic-preference: no default provider → deepseek");
  });

  it("4. expired promo → ox skipped by the chain, but still explicitly selectable", async () => {
    const expired = manifestToProfile({ ...oxAlphaManifest, promo: { until: "2000-01-01T00:00:00Z", note: "expired" } });
    const { deps, registry } = await buildDeps({ oxUsable: true, deepseekUsable: true, oxProfile: expired });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/x" });
    const launcher = new Launcher(deps);
    const auto = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(auto.providerRef.providerId).toBe("deepseek");
    const explicit = await launcher.prepareLaunch({ projectKey: p.id, providerId: "ox-alpha", taskGoal: "x" }, { permissionMode: "safe" });
    expect(explicit.providerRef.providerId).toBe("ox-alpha");
    expect(explicit.autoRoute).toBeUndefined();
  });

  it("5. explicit --provider selection is never chain-routed", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, providerId: "deepseek", taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.autoRoute).toBeUndefined();
  });

  it("5b. an explicit ox-alpha selection stays on ox-alpha (never silently switched)", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, providerId: "ox-alpha", taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("ox-alpha");
    expect(prep.providerRef.model).toBe("stealth/ox-alpha");
    expect(prep.runtimeKind).toBe("cli");
    expect(prep.autoRoute).toBeUndefined();
  });

  it("5c. ox bypass mode emits the verified Claude Code flag; safe mode does not", async () => {
    const { deps, project } = await projectWithDefault();
    const launcher = new Launcher(deps);
    const bypass = await launcher.prepareLaunch({ projectKey: project.id, providerId: "ox-alpha", taskGoal: "x" }, { permissionMode: "bypass" });
    expect(bypass.plan.bypassPermissions).toBe(true);
    expect(bypass.plan.args).toContain("--dangerously-skip-permissions");
    const safe = await launcher.prepareLaunch({ projectKey: project.id, providerId: "ox-alpha", taskGoal: "x" }, { permissionMode: "safe" });
    expect(safe.plan.bypassPermissions).toBe(false);
    expect(safe.plan.args).not.toContain("--dangerously-skip-permissions");
  });

  it("6. explicit --model selection is never chain-routed", async () => {
    const { deps, registry } = await buildDeps({ oxUsable: true, deepseekUsable: true });
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
    const first = await launcher.prepareLaunch({ projectKey: project.id, providerId: "ox-alpha", taskGoal: "first" }, { permissionMode: "safe" });
    expect(first.providerRef.providerId).toBe("ox-alpha");
    const resumed = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(resumed.providerRef.providerId).toBe("ox-alpha");
    expect(resumed.autoRoute).toBeUndefined();
  });

  it("8. a non-chain project default (claude) is never chain-routed", async () => {
    const { deps, registry } = await buildDeps({ oxUsable: true, deepseekUsable: true });
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
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
    expect(prep.autoRoute).toEqual({ chain: ["ghost", "deepseek"], index: 1 });
  });

  it("10. deepseek-default project upgrades to ox while the promo is active", async () => {
    const { deps, registry } = await buildDeps({ oxUsable: true, deepseekUsable: true });
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ds", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("ox-alpha");
    expect(prep.autoRoute?.index).toBe(0);
    expect(prep.modelDecision.reason).toContain("automatic-preference: deepseek default → ox-alpha");
  });

  it("11. when no chain member is usable, the existing interactive prompt path is preserved", async () => {
    // Only claude is usable here (fake CLI auth adapter); no ox/deepseek credentials.
    const { deps, registry } = await buildDeps({});
    const p = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/c" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("claude");
    expect(prep.autoRoute).toBeUndefined();
    expect(prep.modelDecision.reason).toBe("provider default");
  });
});
