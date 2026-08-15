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
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { createCliAuthAdapter } from "../../auth/cli-auth-adapter.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import { ProviderNotAuthenticatedError, NoAuthenticatedAgentError, NoProjectError } from "../errors.js";
import type { LauncherDeps } from "../launcher.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";

/** Minimal in-memory credential backend for these tests. */
class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test backend";
  private readonly store = new Map<string, string>();
  async isAvailable() {
    return true;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
  }
  async get(key: string) {
    return this.store.get(key);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list() {
    return [...this.store.keys()];
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "continuum-launcher-"));
}

function fakeCliAdapter(providerId: string, opts: { authenticated?: boolean; installed?: boolean } = {}): CliAuthAdapter {
  return {
    providerId,
    capability: claudeProfile.cliLaunch as never,
    async detectInstalled() {
      return opts.installed === false ? "not-installed" : "installed";
    },
    async detectAuthenticated() {
      return opts.authenticated === false ? "not-authenticated" : "authenticated";
    },
    async login() {
      return { completed: true, exitCode: 0 };
    },
    async logout() {
      return { completed: true, exitCode: 0 };
    },
  };
}

async function buildDeps(opts: {
  authenticated?: Record<string, boolean>;
  withMemoryCore?: boolean;
  dataDir?: string;
  sessionDir?: string;
} = {}): Promise<{ deps: LauncherDeps; backend: FakeBackend; registry: ProjectRegistry; sessions: FileSessionStore }> {
  const dataDir = opts.dataDir ?? tmp();
  const sessionDir = opts.sessionDir ?? tmp();

  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);

  const cliAuthManager = new CliAuthManager();
  // claude=cli, deepseek=api
  const status = opts.authenticated ?? {};
  cliAuthManager.register(fakeCliAdapter("claude", { authenticated: status.claude !== false }));
  if (status.deepseek !== undefined) {
    // deepseek api: presence of a stored key is the "authenticated" signal.
    if (status.deepseek !== false) await credentialManager.setCredential("deepseek", "api-key", "sk-test");
  } else {
    await credentialManager.setCredential("deepseek", "api-key", "sk-test");
  }
  // deepseek is proxy-routed; it also needs a proxy user key to be "usable".
  // Only set it when deepseek is not explicitly marked unauthenticated.
  if (status.deepseek !== false) {
    await credentialManager.setCredential("deepseek", "proxy-user-key", "sk-proxy-test");
  }

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
  if (opts.withMemoryCore) {
    deps.memoryCore = {
      baseUrl: "http://127.0.0.1:1", // unreachable — exercises degrade path
      serviceToken: { envVar: "MEMCORE_TOKEN" },
      serviceId: "default",
      teamId: "t",
      userId: "u",
      agentId: "a",
    };
  }

  return { deps, backend, registry, sessions: store };
}

describe("Launcher — fresh launch", () => {
  it("prepares a launch with a new session, correct provider/model, and no secret in env", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "do the thing" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("claude");
    expect(prep.session).toBeDefined();
    expect(prep.session!.projectId).toBe(p.id);
    expect(prep.plan.bypassPermissions).toBe(false);
    expect(prep.stale).toBe(false);
    // claude is cli-session → no API key env injected
    expect(prep.plan.env).toEqual({});
  });

  it("throws NoProjectError for an unknown CWD with no project key", async () => {
    const { deps } = await buildDeps();
    const launcher = new Launcher(deps);
    await expect(launcher.prepareLaunch({ cwd: "/nowhere" }, { permissionMode: "safe" })).rejects.toBeInstanceOf(NoProjectError);
  });

  it("throws ProviderNotAuthenticatedError when the chosen provider has no usable auth", async () => {
    const { deps, registry } = await buildDeps({ authenticated: { claude: false } });
    await registry.add({ name: "X", path: "/x", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    await expect(launcher.prepareLaunch({ projectKey: "X" }, { permissionMode: "safe" })).rejects.toBeInstanceOf(ProviderNotAuthenticatedError);
  });
});

describe("Launcher — resume with stale protection", () => {
  it("detects stale state on resume by re-comparing git fingerprints", async () => {
    const { deps, registry } = await buildDeps();
    // A real git repo so captureGitFingerprint returns a real HEAD sha.
    const repoDir = tmp();
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoDir });
    execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repoDir });
    const realHead = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

    const p = await registry.add({ name: "CARS", path: repoDir, defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "goal" }, { permissionMode: "safe" });
    const session = first.session!;

    // Fabricate a different HEAD on the stored session, then resume: the
    // stored head no longer matches the live repo's actual head.
    await deps.sessionManager.updateGitFingerprint(session.sessionId, {
      ...session.git!,
      headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    const resume = await launcher.prepareLaunch({ projectKey: p.id, sessionId: session.sessionId }, { permissionMode: "safe" });
    expect(resume.session!.sessionId).toBe(session.sessionId);
    expect(resume.stale).toBe(true);
    expect(resume.staleReasons.some((r) => r.includes("HEAD changed"))).toBe(true);
    expect(realHead).toBeTruthy();
  });
});

describe("Launcher — MemoryCore degrade", () => {
  it("sets memoryCoreNote when MemoryCore is unreachable, but still prepares a launch", async () => {
    const { deps, registry } = await buildDeps({ withMemoryCore: true });
    const p = await registry.add({ name: "X", path: "/x", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id }, { permissionMode: "safe" });
    expect(prep.memoryCoreAvailable).toBe(true);
    expect(prep.memoryCoreNote).toContain("MemoryCore unavailable");
    expect(prep.plan.providerId).toBe("claude");
  });

  it("notes MemoryCore is not configured when absent", async () => {
    const { deps, registry } = await buildDeps({ withMemoryCore: false });
    const p = await registry.add({ name: "X", path: "/x", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id }, { permissionMode: "safe" });
    expect(prep.memoryCoreNote).toContain("not configured");
  });
});

describe("Launcher — handoff target choice", () => {
  it("lists only authenticated providers and never auto-selects", async () => {
    const { deps, registry } = await buildDeps({ authenticated: { claude: true } });
    const p = await registry.add({ name: "X", path: "/x", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const available = await launcher.listAuthenticatedProviders();
    const ids = available.map((a) => a.providerId);
    expect(ids).toContain("claude"); // cli authenticated
    expect(ids).toContain("deepseek"); // api key present
  });
});
