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
import { ProviderNotAuthenticatedError, NoAuthenticatedAgentError, NoProjectError, LocalDependencyUnavailableError } from "../errors.js";
import { HandoffManager } from "../../handoff/manager.js";
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
  route?: "direct" | "proxy";
  ensureProxyReady?: LauncherDeps["ensureProxyReady"];
  onDependencyProgress?: LauncherDeps["onDependencyProgress"];
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
  // deepseek also stores a proxy user key (for the optional proxy route). Only
  // set it when deepseek is not explicitly marked unauthenticated.
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
    ...(opts.route ? { getProviderRoute: (): "direct" | "proxy" => opts.route! } : {}),
    ...(opts.ensureProxyReady ? { ensureProxyReady: opts.ensureProxyReady } : {}),
    ...(opts.onDependencyProgress ? { onDependencyProgress: opts.onDependencyProgress } : {}),
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

describe("Launcher — General / No-Project mode", () => {
  it("prepares a fresh launch with no project registration, no git fingerprint, and mode='general'", async () => {
    const { deps, registry } = await buildDeps();
    const cwd = tmp();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ mode: "general", cwd, providerId: "claude", taskGoal: "explore" }, { permissionMode: "safe" });

    expect(prep.session).toBeDefined();
    expect(prep.session!.mode).toBe("general");
    expect(prep.session!.projectId).toBeUndefined();
    expect(prep.session!.workingDirectory).toBe(cwd);
    expect(prep.session!.git).toBeUndefined();
    expect(prep.plan.workingDir).toBe(cwd);
    // Never touches the project registry.
    expect(await registry.list()).toHaveLength(0);
  });

  it("allows normal provider selection and never injects a project default", async () => {
    const { deps } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "deepseek", taskGoal: "chat" }, { permissionMode: "safe" });
    expect(prep.providerRef.providerId).toBe("deepseek");
  });

  it("resumes a general session using its own stored working directory, without a projectId lookup", async () => {
    const { deps } = await buildDeps();
    const cwd = tmp();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ mode: "general", cwd, providerId: "claude", taskGoal: "explore" }, { permissionMode: "safe" });
    const sessionId = first.session!.sessionId;

    const resumed = await launcher.prepareLaunch({ sessionId }, { permissionMode: "safe" });
    expect(resumed.session!.sessionId).toBe(sessionId);
    expect(resumed.session!.mode).toBe("general");
    expect(resumed.plan.workingDir).toBe(cwd);
    expect(resumed.stale).toBe(false);
  });
});

describe("Launcher — Current Directory mode", () => {
  it("anchors the session to the launch cwd, keeps git fingerprinting, and never registers a project", async () => {
    const { deps, registry } = await buildDeps();
    const repoDir = tmp();
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoDir });
    execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repoDir });

    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ mode: "current-directory", cwd: repoDir, providerId: "claude", taskGoal: "quick fix" }, { permissionMode: "safe" });

    expect(prep.session!.mode).toBe("current-directory");
    expect(prep.session!.projectId).toBeUndefined();
    expect(prep.session!.workingDirectory).toBe(repoDir);
    expect(prep.session!.git).toBeDefined();
    expect(prep.session!.git!.repoRoot).toBeTruthy();
    expect(await registry.list()).toHaveLength(0);
  });

  it("resumes a current-directory session against its stored directory and still detects staleness", async () => {
    const { deps } = await buildDeps();
    const repoDir = tmp();
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoDir });
    execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repoDir });

    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ mode: "current-directory", cwd: repoDir, providerId: "claude", taskGoal: "quick fix" }, { permissionMode: "safe" });
    const session = first.session!;

    await deps.sessionManager.updateGitFingerprint(session.sessionId, {
      ...session.git!,
      headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    const resumed = await launcher.prepareLaunch({ sessionId: session.sessionId }, { permissionMode: "safe" });
    expect(resumed.session!.mode).toBe("current-directory");
    expect(resumed.stale).toBe(true);
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

// ── Local-dependency readiness gate (root cause: ConnectionRefused / retry-loop) ──
//
// DeepSeek is CONTINUUM's one proxy-routed provider (Tencent MemoryProxy).
// These tests prove: the gate only engages for proxy-routed providers, it
// runs before any session state is touched (so a block never loses task or
// handoff state), a ready proxy is a no-op, and project/general/current-
// directory launch behavior for the unaffected (non-proxy) case is unchanged.

describe("Launcher — proxy readiness gate (DeepSeek, optional proxy route)", () => {
  it("blocks a fresh DeepSeek proxy launch when ensureProxyReady reports not-ready, before creating any session", async () => {
    const ensureProxyReady = async () => ({ ready: false, detail: "proxy unreachable (127.0.0.1:8096) — no automatic repair available", repairAttempted: true });
    const { deps, sessions } = await buildDeps({ ensureProxyReady, route: "proxy" });
    const launcher = new Launcher(deps);

    await expect(
      launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "deepseek", taskGoal: "explore" }, { permissionMode: "safe" }),
    ).rejects.toThrow(LocalDependencyUnavailableError);

    // No session was ever created — nothing to lose, retry after fixing the
    // proxy starts completely clean.
    expect(await sessions.listSessionIds()).toEqual([]);
  });

  it("never even calls ensureProxyReady for a direct DeepSeek launch (no Tencent gate)", async () => {
    let called = false;
    const ensureProxyReady = async () => {
      called = true;
      return { ready: true, detail: "", repairAttempted: false };
    };
    const { deps } = await buildDeps({ ensureProxyReady });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "deepseek", taskGoal: "explore" }, { permissionMode: "safe" });
    expect(prep.session).toBeDefined();
    expect(called).toBe(false);
  });

  it("never even calls ensureProxyReady for Claude (cli-session auth, not proxy-routed)", async () => {
    let called = false;
    const ensureProxyReady = async () => {
      called = true;
      return { ready: true, detail: "", repairAttempted: false };
    };
    const { deps } = await buildDeps({ ensureProxyReady });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "claude", taskGoal: "explore" }, { permissionMode: "safe" });

    expect(prep.session).toBeDefined();
    expect(called).toBe(false);
  });

  it("proceeds normally (no error, no visible delay) when ensureProxyReady reports ready in proxy mode", async () => {
    const ensureProxyReady = async () => ({ ready: true, detail: "proxy healthy", repairAttempted: false });
    const { deps } = await buildDeps({ ensureProxyReady, route: "proxy" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "deepseek", taskGoal: "explore" }, { permissionMode: "safe" });
    expect(prep.session).toBeDefined();
    expect(prep.providerRef.providerId).toBe("deepseek");
  });

  it("surfaces onDependencyProgress lines from ensureProxyReady (stateful UX, not raw retry spam)", async () => {
    const progress: string[] = [];
    const ensureProxyReady = async (_url: string, onProgress?: (line: string) => void) => {
      onProgress?.("Proxy unavailable at 127.0.0.1:8096 — checking service…");
      onProgress?.("Recovered in 1.2s — resuming session.");
      return { ready: true, detail: "proxy recovered", repairAttempted: true };
    };
    const { deps } = await buildDeps({ ensureProxyReady, route: "proxy", onDependencyProgress: (line) => progress.push(line) });
    const launcher = new Launcher(deps);
    await launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "deepseek", taskGoal: "explore" }, { permissionMode: "safe" });
    expect(progress).toEqual(["Proxy unavailable at 127.0.0.1:8096 — checking service…", "Recovered in 1.2s — resuming session."]);
  });

  it("blocks a resume when the proxy is down without mutating the existing session (session survives a transient outage)", async () => {
    // First, launch successfully while the proxy is healthy.
    const readyState = { ready: true };
    const ensureProxyReady = async () => ({ ready: readyState.ready, detail: readyState.ready ? "healthy" : "proxy down", repairAttempted: false });
    const { deps } = await buildDeps({ ensureProxyReady, route: "proxy" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "deepseek", taskGoal: "explore" }, { permissionMode: "safe" });
    const sessionId = first.session!.sessionId;
    const before = await deps.sessionManager.loadSession(sessionId);

    // Proxy goes down; resuming the SAME session must fail without touching it.
    readyState.ready = false;
    await expect(launcher.prepareLaunch({ sessionId }, { permissionMode: "safe" })).rejects.toThrow(LocalDependencyUnavailableError);

    const after = await deps.sessionManager.loadSession(sessionId);
    expect(after.revision).toBe(before.revision);
    expect(after.taskGoal).toBe(before.taskGoal);
    expect(after.status).toBe(before.status);

    // Proxy recovers; the exact same session resumes cleanly — nothing lost.
    readyState.ready = true;
    const resumed = await launcher.prepareLaunch({ sessionId }, { permissionMode: "safe" });
    expect(resumed.session!.sessionId).toBe(sessionId);
  });

  it("handoff survives a transient outage: a blocked handoff-to-DeepSeek keeps the recorded handoff and stays resumable", async () => {
    const readyState = { ready: true };
    const ensureProxyReady = async () => ({ ready: readyState.ready, detail: readyState.ready ? "healthy" : "proxy down", repairAttempted: false });
    const { deps } = await buildDeps({ ensureProxyReady, route: "proxy", authenticated: { claude: true } });
    const launcher = new Launcher(deps);
    const handoffManager = new HandoffManager(deps.sessionManager, deps.providers);

    // Start on Claude.
    const first = await launcher.prepareLaunch({ mode: "general", cwd: tmp(), providerId: "claude", taskGoal: "explore" }, { permissionMode: "safe" });
    const sessionId = first.session!.sessionId;

    // Proxy is down when the handoff to DeepSeek is attempted — mirrors
    // runHandoffCommand's real sequence: finalizeHandoff commits first, then
    // prepareLaunch is what actually gates on proxy readiness.
    readyState.ready = false;
    await handoffManager.finalizeHandoff(sessionId, "deepseek", { tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 } });
    await expect(launcher.prepareLaunch({ sessionId, providerId: "deepseek" }, { permissionMode: "safe" })).rejects.toThrow(LocalDependencyUnavailableError);

    // The handoff record and provider switch are NOT lost — that's durable,
    // intentional state (finalizeHandoff already committed it). What matters
    // for "survives the outage" is that nothing is corrupted and a retry
    // after the proxy recovers resumes the exact same session cleanly.
    const midOutage = await deps.sessionManager.loadSession(sessionId);
    expect(midOutage.activeProvider.providerId).toBe("deepseek");
    expect(midOutage.lastHandoff?.toProvider.providerId).toBe("deepseek");

    readyState.ready = true;
    const resumed = await launcher.prepareLaunch({ sessionId }, { permissionMode: "safe" });
    expect(resumed.session!.sessionId).toBe(sessionId);
    expect(resumed.session!.activeProvider.providerId).toBe("deepseek");
    expect(resumed.session!.lastHandoff?.toProvider.providerId).toBe("deepseek");
  });
});
