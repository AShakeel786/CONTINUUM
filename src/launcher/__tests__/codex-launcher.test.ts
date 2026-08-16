import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher } from "../launcher.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import { ProviderNotAuthenticatedError } from "../errors.js";
import type { LauncherDeps } from "../launcher.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";

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

function fakeCliAdapter(providerId: string, opts: { authenticated?: boolean; installed?: boolean } = {}): CliAuthAdapter {
  return {
    providerId,
    capability: codexProfile.cliLaunch as never,
    async detectInstalled() { return opts.installed === false ? "not-installed" : "installed"; },
    async detectAuthenticated() { return opts.authenticated === false ? "not-authenticated" : "authenticated"; },
    async login() { return { completed: true, exitCode: 0 }; },
    async logout() { return { completed: true, exitCode: 0 }; },
  };
}

async function buildDeps(opts: { codex?: { authenticated?: boolean; installed?: boolean } } = {}): Promise<{ deps: LauncherDeps; registry: ProjectRegistry; sessionManager: SessionManager }> {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-codex-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-codex-sess-"));

  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(codexProfile));

  const credentialManager = new CredentialManager(new FakeBackend());
  await credentialManager.setCredential("deepseek", "api-key", "sk-test");
  await credentialManager.setCredential("deepseek", "proxy-user-key", "sk-proxy-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));
  cliAuthManager.register(fakeCliAdapter("codex", opts.codex ?? {}));

  const authMetadata = createDefaultProviderAuthMetadata();
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });

  const store = new FileSessionStore(sessionDir);
  const sessionManager = new SessionManager(store);

  const deps: LauncherDeps = {
    projects: registry,
    providers,
    credentialManager,
    cliAuthManager,
    authVerifier,
    authMetadata,
    sessionManager,
    prompt: createScriptedPrompt({}),
    sessionBaseDir: sessionDir,
  };

  return { deps, registry, sessionManager };
}

describe("Launcher — Codex project launch", () => {
  it("prepares a native codex launch with no injected credential/configDir", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "do the thing" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("codex");
    expect(prep.providerRef.model).toBe("gpt-5.6-sol");
    expect(prep.plan.executable).toBe("codex");
    expect(prep.plan.env).toEqual({}); // no API key / OAuth token injected
    expect(prep.plan.configDir).toBeUndefined(); // native ~/.codex, not CLAUDE_CONFIG_DIR
    expect(prep.plan.bypassPermissions).toBe(false); // safe-by-default
  });

  it("bypassPermissions stays false unless the caller explicitly opts in", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id }, { permissionMode: "safe" });
    expect(prep.plan.bypassPermissions).toBe(false);
  });
});

describe("Launcher — Codex auth gating", () => {
  it("throws ProviderNotAuthenticatedError when codex CLI is not authenticated", async () => {
    const { deps, registry } = await buildDeps({ codex: { authenticated: false } });
    await registry.add({ name: "X", path: "/x", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    await expect(launcher.prepareLaunch({ projectKey: "X" }, { permissionMode: "safe" })).rejects.toBeInstanceOf(ProviderNotAuthenticatedError);
  });

  it("throws ProviderNotAuthenticatedError when codex CLI is not installed", async () => {
    const { deps, registry } = await buildDeps({ codex: { installed: false } });
    await registry.add({ name: "X", path: "/x", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    await expect(launcher.prepareLaunch({ projectKey: "X" }, { permissionMode: "safe" })).rejects.toBeInstanceOf(ProviderNotAuthenticatedError);
  });
});

describe("Launcher — Codex session resume", () => {
  it("resumes an existing codex session and keeps the active provider, no re-audit", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);

    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    const sessionId = first.session!.sessionId;
    await sessionManager.addCompletedWork(sessionId, "built the core");

    const resume = await launcher.prepareLaunch({ projectKey: p.id, sessionId }, { permissionMode: "safe" });
    expect(resume.session!.sessionId).toBe(sessionId);
    expect(resume.session!.activeProvider.providerId).toBe("codex");
    expect(resume.plan.executable).toBe("codex");
  });
});
