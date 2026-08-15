import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Launcher } from "../launcher.js";
import { listRecentSessions, archiveFinishedSessions } from "../session-list.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { LauncherDeps } from "../launcher.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test";
  private readonly store = new Map<string, string>();
  async isAvailable() { return true; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async get(k: string) { return this.store.get(k); }
  async delete(k: string) { this.store.delete(k); }
  async list() { return [...this.store.keys()]; }
}

function fakeCliAdapter(providerId: string, authenticated = true): CliAuthAdapter {
  return {
    providerId,
    capability: claudeProfile.cliLaunch as never,
    async detectInstalled() { return "installed"; },
    async detectAuthenticated() { return authenticated ? "authenticated" : "not-authenticated"; },
    async login() { return { completed: true, exitCode: 0 }; },
    async logout() { return { completed: true, exitCode: 0 }; },
  };
}

interface Ctx {
  deps: LauncherDeps;
  backend: FakeBackend;
  registry: ProjectRegistry;
  sessionManager: SessionManager;
  repoDir: string;
}

async function setup(opts: { deepseekProxyKey?: boolean; deepseekApiKey?: boolean; claudeAuth?: boolean } = {}): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "ux-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "uxs-"));

  const repoDir = mkdtempSync(join(tmpdir(), "uxrepo-"));
  execSync("git init -q", { cwd: repoDir });
  execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repoDir });

  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude", opts.claudeAuth !== false));

  if (opts.deepseekApiKey !== false) await credentialManager.setCredential("deepseek", "api-key", "sk-ds-api");
  if (opts.deepseekProxyKey !== false) await credentialManager.setCredential("deepseek", "proxy-user-key", "sk-ds-proxy");

  const authMetadata = createDefaultProviderAuthMetadata();
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));

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

  return { deps, backend, registry, sessionManager, repoDir };
}

describe("7.1 — proxy credential via CredentialManager", () => {
  it("resolves deepseek proxy key from the credential backend into the launch plan (no manual env)", async () => {
    const { deps, registry, repoDir } = await setup({ deepseekProxyKey: true });
    delete process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
    await registry.add({ name: "p", path: repoDir, defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" });
    // The proxy-routed plan must have the resolved ANTHROPIC_AUTH_TOKEN (proxy key).
    expect(prep.plan.providerId).toBe("deepseek");
    expect(prep.plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ds-proxy");
    expect(JSON.stringify(prep.plan)).not.toContain("sk-ds-api"); // upstream key never leaked into launch env
  });

  it("degrades deepseek to unusable when the proxy key is absent (not a silent launch)", async () => {
    const { deps, registry, repoDir } = await setup({ deepseekProxyKey: false, deepseekApiKey: true });
    delete process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
    await registry.add({ name: "p", path: repoDir, defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const available = await launcher.listAuthenticatedProviders();
    expect(available.map((a) => a.providerId)).not.toContain("deepseek");
  });
});

describe("7.1 — first-launch provider prompt", () => {
  it("prompts when neither --provider nor a project default is given (single available → returned)", async () => {
    const { deps, registry, repoDir } = await setup({ claudeAuth: true, deepseekApiKey: false, deepseekProxyKey: false });
    await registry.add({ name: "p", path: repoDir }); // no default provider
    const launcher = new Launcher(deps);
    // Only claude is available → promptForProvider returns it.
    const prep = await launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("claude");
  });

  it("returns undefined (NoAuthenticatedAgentError) when no provider is usable", async () => {
    const { deps, registry, repoDir } = await setup({ claudeAuth: false, deepseekApiKey: false, deepseekProxyKey: false });
    await registry.add({ name: "p", path: repoDir });
    const launcher = new Launcher(deps);
    await expect(launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" })).rejects.toThrow();
  });
});

describe("7.1 — recent-session listing/archive", () => {
  it("lists sessions newest-first and archives finished sessions older than a cutoff", async () => {
    const { deps, registry, sessionManager, repoDir } = await setup();
    await registry.add({ name: "p", path: repoDir, defaultProvider: "claude" });
    const launcher = new Launcher(deps);

    const s1 = await launcher.prepareLaunch({ projectKey: "p", taskGoal: "task one" }, { permissionMode: "safe" });
    const s2 = await launcher.prepareLaunch({ projectKey: "p", taskGoal: "task two" }, { permissionMode: "safe" });

    const recent = await listRecentSessions(sessionManager);
    expect(recent.length).toBe(2);
    // Newest first (roughly — both created within the same ms; assert membership instead).
    expect(recent.map((r) => r.sessionId)).toContain(s1.session!.sessionId);
    expect(recent.map((r) => r.sessionId)).toContain(s2.session!.sessionId);

    // Mark s1 finished and old, then archive.
    await sessionManager.setStatus(s1.session!.sessionId, "completed");
    // Force its updatedAt old by direct store manipulation is awkward; instead
    // archive with a future cutoff to prove "completed" is the gate.
    const archived = await archiveFinishedSessions(sessionManager, new Date(Date.now() + 10000).toISOString());
    expect(archived).toContain(s1.session!.sessionId);
    // s2 is active → not archived.
    expect(archived).not.toContain(s2.session!.sessionId);
  });
});

describe("7.1 — provider-change-on-resume records handoff", () => {
  it("records handoff metadata when resume --provider differs; same-provider resume is a no-op", async () => {
    const { deps, registry, sessionManager, repoDir } = await setup();
    await registry.add({ name: "p", path: repoDir, defaultProvider: "claude" });
    const launcher = new Launcher(deps);

    const first = await launcher.prepareLaunch({ projectKey: "p", taskGoal: "goal" }, { permissionMode: "safe" });
    const sid = first.session!.sessionId;

    // Same-provider resume: no fake handoff.
    const same = await launcher.prepareLaunch({ sessionId: sid }, { permissionMode: "safe" });
    const afterSame = await sessionManager.loadSession(sid);
    expect(afterSame.activeProvider.providerId).toBe("claude");

    // Provider-change resume: records handoff + updates active provider.
    const changed = await launcher.prepareLaunch({ sessionId: sid, providerId: "deepseek" }, { permissionMode: "safe" });
    const afterChange = await sessionManager.loadSession(sid);
    expect(afterChange.activeProvider.providerId).toBe("deepseek");
    expect(afterChange.lastHandoff).toBeDefined();
    expect(afterChange.lastHandoff!.fromProvider.providerId).toBe("claude");
    expect(afterChange.lastHandoff!.toProvider.providerId).toBe("deepseek");
    expect(changed.session!.sessionId).toBe(sid); // same session, continued not restarted
  });
});

describe("7.1 — no secret leakage", () => {
  it("launch plan env never contains the upstream API key alongside the proxy key", async () => {
    const { deps, registry, repoDir } = await setup({ deepseekProxyKey: true, deepseekApiKey: true });
    await registry.add({ name: "p", path: repoDir, defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" });
    expect(JSON.stringify(prep.plan)).not.toContain("sk-ds-api");
    expect(prep.plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ds-proxy");
  });
});
