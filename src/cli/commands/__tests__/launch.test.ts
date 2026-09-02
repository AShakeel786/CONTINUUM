import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsNativeSessionCapture, launchPrepared } from "../launch.js";
import { runApiAgent } from "../../../api-agent/run.js";
import { ApiAgentError } from "../../../api-agent/types.js";
import { Launcher, type LauncherDeps } from "../../../launcher/launcher.js";
import type { LaunchPreparation } from "../../../launcher/types.js";
import type { LaunchPlan } from "../../../launcher/types.js";
import { ProjectRegistry } from "../../../registry/registry.js";
import { ProjectRegistryStore } from "../../../registry/store.js";
import { ProviderRegistry } from "../../../providers/registry.js";
import { createProviderAdapter } from "../../../providers/adapter.js";
import { claudeProfile } from "../../../providers/profiles/claude.js";
import { deepseekProfile } from "../../../providers/profiles/deepseek.js";
import { glm52FreeManifest, localOrnith15Manifest } from "../../../providers/presets.js";
import { manifestToProfile, manifestToAuthMetadata, type ProviderManifest } from "../../../providers/manifest.js";
import { CredentialManager } from "../../../auth/credential-manager.js";
import { CliAuthManager } from "../../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../../auth/auth-verifier.js";
import { SessionManager } from "../../../session/manager.js";
import { FileSessionStore } from "../../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../../auth/prompt.js";
import { MEMORY_CORE_ENV_ONLY_ENV } from "../../../context/memorycore-config.js";
import type { CredentialBackend, CliAuthAdapter } from "../../../auth/types.js";
import type { ProviderProfile } from "../../../providers/types.js";

// launchPrepared's API branch runs the generic api-agent loop — mock it so
// runtime failures (rate-limit/auth/…) are scripted without any real HTTP.
vi.mock("../../../api-agent/run.js", () => ({ runApiAgent: vi.fn() }));
const mockedRun = vi.mocked(runApiAgent);

function prep(overrides: Partial<LaunchPreparation> = {}): LaunchPreparation {
  return {
    session: { sessionId: "logical-session" },
    providerRef: { providerId: "codex", model: "gpt-5.6-sol" },
    ...overrides,
  } as LaunchPreparation;
}

describe("native session capture guard", () => {
  it("captures a new non-deterministic provider session", () => {
    const launcher = { supportsDeterministicSessionId: vi.fn(() => false) } as unknown as Launcher;
    expect(needsNativeSessionCapture(launcher, prep())).toBe(true);
  });

  it("never store-scans an existing native resume", () => {
    const launcher = { supportsDeterministicSessionId: vi.fn(() => false) } as unknown as Launcher;
    expect(
      needsNativeSessionCapture(
        launcher,
        prep({ nativeResume: { providerId: "codex", nativeSessionId: "native-session" } }),
      ),
    ).toBe(false);
  });

  it("does not capture deterministic providers or launches without a logical session", () => {
    const deterministic = { supportsDeterministicSessionId: vi.fn(() => true) } as unknown as Launcher;
    expect(needsNativeSessionCapture(deterministic, prep())).toBe(false);

    const nonDeterministic = { supportsDeterministicSessionId: vi.fn(() => false) } as unknown as Launcher;
    expect(needsNativeSessionCapture(nonDeterministic, prep({ session: undefined }))).toBe(false);
  });
});

// ── Automatic-routing fallback (GLM 5.2 Free → DeepSeek) ─────────────────

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

interface FallbackDepsOpts {
  readonly glmUsable?: boolean;
  readonly deepseekUsable?: boolean;
  readonly chain?: readonly string[];
  readonly extraProfiles?: readonly ProviderProfile[];
  readonly extraManifests?: readonly ProviderManifest[];
  /** Executable detection override — claude present unless explicitly disabled. */
  readonly findExecutable?: (executable: string) => string | undefined;
  /** Register the bundled managed-local Ornith provider. */
  readonly registerOrnith?: boolean;
  readonly memoryCore?: LauncherDeps["memoryCore"];
  readonly ensureLocalService?: LauncherDeps["ensureLocalService"];
}

async function buildFallbackDeps(opts: FallbackDepsOpts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-fallback-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-fallback-sess-"));
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(manifestToProfile(glm52FreeManifest)));
  if (opts.registerOrnith) providers.register(createProviderAdapter(manifestToProfile(localOrnith15Manifest)));
  for (const profile of opts.extraProfiles ?? []) providers.register(createProviderAdapter(profile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  if (opts.deepseekUsable) await credentialManager.setCredential("deepseek", "api-key", "sk-ds-test");
  if (opts.glmUsable) await credentialManager.setCredential("glm-5-2-free", "api-key", "sk-glm-test");
  for (const manifest of opts.extraManifests ?? []) {
    await credentialManager.setCredential(manifest.id, "api-key", `sk-${manifest.id}-test`);
  }

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));

  const authMetadata = new Map(createDefaultProviderAuthMetadata());
  for (const manifest of opts.extraManifests ?? []) authMetadata.set(manifest.id, manifestToAuthMetadata(manifest));

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
    preferredProviderChain: opts.chain ?? ["glm-5-2-free", "deepseek"],
    ...(opts.findExecutable
      ? { findExecutable: opts.findExecutable }
      : { findExecutable: (e: string) => (e === "claude" ? "/fake/claude" : undefined) }),
    ...(opts.memoryCore ? { memoryCore: opts.memoryCore } : {}),
    ...(opts.ensureLocalService ? { ensureLocalService: opts.ensureLocalService } : {}),
  };
  return { deps, registry, sessionManager, dataDir };
}

function collectOut(): { out: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (s: string) => { lines.push(s); }, lines };
}

describe("launchPrepared automatic-routing fallback", () => {
  beforeEach(() => {
    // The tool registry must never probe the real OS credential store.
    process.env[MEMORY_CORE_ENV_ONLY_ENV] = "1";
    mockedRun.mockReset();
  });

  it("dispatches the chain-routed GLM Free to its Claude Code harness (no API agent, redirected env)", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.providerRef.providerId).toBe("glm-5-2-free");
    expect(launchPrep.autoRoute?.index).toBe(0);
    expect(launchPrep.runtimeKind).toBe("cli");

    const { out } = collectOut();
    let spawnedPlan: LaunchPlan | undefined;
    const exit = await launchPrepared(
      { launcher, providers: deps.providers, sessionManager, dataDir },
      launchPrep,
      out,
      async (plan) => { spawnedPlan = plan; return { exitCode: 0 }; },
    );

    expect(exit).toBe(0);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(spawnedPlan?.providerId).toBe("glm-5-2-free");
    expect(spawnedPlan?.executable).toBe("claude");
    expect(spawnedPlan?.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(spawnedPlan?.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-glm-test");
    expect(spawnedPlan?.configDir).toContain(".claude-oxalpha");
  });

  it("an explicit launch on the API harness never falls back — it fails fast", async () => {
    const noCli = { findExecutable: () => undefined };
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true, ...noCli });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.autoRoute).toBeUndefined();
    expect(launchPrep.runtimeKind).toBe("api");

    mockedRun.mockRejectedValueOnce(new ApiAgentError("rate-limited", { kind: "rate-limit" }));
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("GLM 5.2 Free (OpenRouter) API connection failed");
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("fails fast when the chain has no usable fallback member (API harness)", async () => {
    const noCli = { findExecutable: () => undefined };
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, ...noCli }); // deepseek: no credential, no claude
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.providerRef.providerId).toBe("glm-5-2-free");
    expect(launchPrep.runtimeKind).toBe("api");

    mockedRun.mockRejectedValueOnce(new ApiAgentError("auth failed", { kind: "auth" }));
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("never falls back on a local (non-ApiAgentError) failure", async () => {
    const noCli = { findExecutable: () => undefined };
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true, ...noCli });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.runtimeKind).toBe("api");

    mockedRun.mockRejectedValueOnce(new Error("local bug in tool registry"));
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("API agent error: local bug in tool registry");
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("constructs one composite API runner instead of restarting runApiAgent", async () => {
    const apiBManifest: ProviderManifest = {
      schemaVersion: 1,
      id: "api-b",
      displayName: "API B",
      protocol: "openai-compatible",
      baseUrl: "https://example.com/v1",
      auth: { kind: "bearer-token", envVar: "B_KEY" },
      models: { default: "b-model" },
      capabilities: { cliAvailable: false },
    };
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({
      glmUsable: true,
      chain: ["glm-5-2-free", "api-b"],
      findExecutable: () => undefined,
      extraManifests: [apiBManifest],
      extraProfiles: [manifestToProfile(apiBManifest)],
    });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.providerRef.providerId).toBe("glm-5-2-free");
    expect(launchPrep.runtimeKind).toBe("api");

    mockedRun.mockRejectedValue(new ApiAgentError("rate-limited", { kind: "rate-limit" }));
    const { out } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0]![0].adapter.profile.id).toBe("glm-5-2-free");
    expect(mockedRun.mock.calls[0]![0].runner).toBeDefined();
  });
});

// ── CLI-harness automatic-routing fallback (runtime provider failure) ──────

const GLM_429_TAIL = "API Error: Request rejected (429) · Provider returned error";

describe("launchPrepared CLI-harness automatic-routing fallback", () => {
  beforeEach(() => {
    process.env[MEMORY_CORE_ENV_ONLY_ENV] = "1";
    mockedRun.mockReset();
  });

  function spawnScripted(scripts: Array<{ exitCode: number | null; stderrTail?: string }>) {
    const plans: LaunchPlan[] = [];
    const spawnFn = async (plan: LaunchPlan) => {
      plans.push(plan);
      return scripts.shift() ?? { exitCode: 0 };
    };
    return { plans, spawnFn };
  }

  it("auto-routed GLM CLI 429 falls back to DeepSeek via its own CLI harness", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.providerRef.providerId).toBe("glm-5-2-free");
    expect(launchPrep.autoRoute?.index).toBe(0);
    expect(launchPrep.runtimeKind).toBe("cli");
    const sessionId = launchPrep.session!.sessionId;
    // The deterministic native id is recorded into the session store during
    // prepareLaunch; the returned snapshot predates that write.
    const oxNativeId = (await sessionManager.loadSession(sessionId)).nativeSessionIds?.["glm-5-2-free"];
    expect(oxNativeId).toBeTruthy();

    const { plans, spawnFn } = spawnScripted([{ exitCode: 1, stderrTail: GLM_429_TAIL }]);
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir, apiFailoverPolicy: { mode: "freeFirst", allowPaidFallback: true } }, launchPrep, out, spawnFn);

    expect(exit).toBe(0);
    expect(plans.length).toBe(2);
    expect(plans[0]!.providerId).toBe("glm-5-2-free");
    // The failed attempt requested bounded stderr capture; the fallback did not need to.
    expect(plans[0]!.stderrTailBytes).toBeTruthy();
    expect(plans[1]!.providerId).toBe("deepseek");
    expect(plans[1]!.env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(lines.join("\n")).toContain("falling back to DeepSeek");

    // Session/handoff semantics: provider transition recorded, native id intact.
    const session = await sessionManager.loadSession(sessionId);
    expect(session.activeProvider.providerId).toBe("deepseek");
    expect(session.lastHandoff?.fromProvider.providerId).toBe("glm-5-2-free");
    expect(session.nativeSessionIds?.["glm-5-2-free"]).toBe(oxNativeId);
  });

  it("auto-routed CLI upstream-provider failure (5xx) also falls back", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });

    const { plans, spawnFn } = spawnScripted([{ exitCode: 1, stderrTail: "API Error: 502 Bad Gateway" }]);
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir, apiFailoverPolicy: { mode: "freeFirst", allowPaidFallback: true } }, launchPrep, out, spawnFn);

    expect(exit).toBe(0);
    expect(plans.length).toBe(2);
    expect(plans[1]!.providerId).toBe("deepseek");
    expect(lines.join("\n")).toContain("falling back");
  });

  it("an explicit GLM CLI failure never switches providers silently", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.autoRoute).toBeUndefined();

    const { plans, spawnFn } = spawnScripted([{ exitCode: 1, stderrTail: GLM_429_TAIL }]);
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out, spawnFn);

    expect(exit).toBe(1);
    expect(plans.length).toBe(1);
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("a user interrupt never falls back", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });

    for (const result of [{ exitCode: 130, stderrTail: "" as string }, { exitCode: null }, { exitCode: 1, stderrTail: "Interrupted by user" }]) {
      const { plans, spawnFn } = spawnScripted([result]);
      const lines: string[] = [];
      const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, (s) => lines.push(s), spawnFn);
      expect(exit).toBe(result.exitCode ?? 0);
      expect(plans.length).toBe(1);
      expect(lines.join("\n")).not.toContain("falling back");
    }
  });

  it("an ordinary task/local CLI failure never falls back", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });

    for (const stderr of ["✗ Tests failed: 3 failing, 12 passing", "Error: ENOENT: no such file or directory", "Permission denied: /etc/hosts", "fatal: unable to push to upstream branch of 'origin'"]) {
      const { plans, spawnFn } = spawnScripted([{ exitCode: 1, stderrTail: stderr }]);
      const lines: string[] = [];
      const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, (s) => lines.push(s), spawnFn);
      expect(exit).toBe(1);
      expect(plans.length).toBe(1);
      expect(lines.join("\n")).not.toContain("falling back");
    }
  });

  it("the fallback chain cannot loop — a failing fallback member is final", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });

    const { plans, spawnFn } = spawnScripted([
      { exitCode: 1, stderrTail: GLM_429_TAIL },
      { exitCode: 1, stderrTail: GLM_429_TAIL },
    ]);
    const lines: string[] = [];
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir, apiFailoverPolicy: { mode: "freeFirst", allowPaidFallback: true } }, launchPrep, (s) => lines.push(s), spawnFn);

    expect(exit).toBe(1);
    expect(plans.length).toBe(2); // ox once, deepseek once — no third attempt
  });

  it("a successful auto-routed CLI launch never touches fallback and captures nothing extra", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });

    const { plans, spawnFn } = spawnScripted([]);
    const lines: string[] = [];
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, (s) => lines.push(s), spawnFn);

    expect(exit).toBe(0);
    expect(plans.length).toBe(1);
    expect(plans[0]!.providerId).toBe("glm-5-2-free");
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("explicit DeepSeek and native Claude CLI failures keep fail-fast behavior", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ glmUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);

    for (const providerId of ["deepseek", "claude"] as const) {
      const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, providerId, taskGoal: "do it" }, { permissionMode: "safe" });
      expect(launchPrep.runtimeKind).toBe("cli");
      const { plans, spawnFn } = spawnScripted([{ exitCode: 1, stderrTail: GLM_429_TAIL }]);
      const lines: string[] = [];
      const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, (s) => lines.push(s), spawnFn);
      expect(exit).toBe(1);
      expect(plans.length).toBe(1);
      expect(lines.join("\n")).not.toContain("falling back");
    }
  });

  it("a CLI failure can fall forward onto an API-harness chain member", async () => {
    const apiBManifest: ProviderManifest = {
      schemaVersion: 1,
      id: "api-b",
      displayName: "API B",
      protocol: "openai-compatible",
      baseUrl: "https://example.com/v1",
      auth: { kind: "bearer-token", envVar: "B_KEY" },
      models: { default: "b-model" },
      capabilities: { cliAvailable: false },
    };
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({
      glmUsable: true,
      chain: ["glm-5-2-free", "api-b"],
      extraManifests: [apiBManifest],
      extraProfiles: [manifestToProfile(apiBManifest)],
    });
    const project = await registry.add({ name: `cf-${Math.random().toString(36).slice(2, 8)}`, path: "/work/cf" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.runtimeKind).toBe("cli");

    mockedRun.mockResolvedValueOnce({ finalContent: "fallback ok" } as never);
    const { plans, spawnFn } = spawnScripted([{ exitCode: 1, stderrTail: GLM_429_TAIL }]);
    const lines: string[] = [];
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir, apiFailoverPolicy: { mode: "freeFirst", allowPaidFallback: true } }, launchPrep, (s) => lines.push(s), spawnFn);

    expect(exit).toBe(0);
    expect(plans.length).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0]![0].adapter.profile.id).toBe("api-b");
    expect(lines.join("\n")).toContain("falling back to API B");
  });
});

// ── Direct-API memory_recall is project-scoped (live regression) ──────────
//
// Regression for: a project launch on a managed-local Direct-API provider
// whose api-agent `memory_recall` tool recalled another project's global
// MemoryCore persona. The in-process tool registry built by `launchPrepared`
// must carry the same per-project scope the launcher's own recall uses.
describe("Direct-API api-agent memory_recall project scoping", () => {
  const MEM_ENV = ["CONTINUUM_MEMORY_CORE_URL", "CONTINUUM_MEMORY_CORE_TOKEN", "CONTINUUM_MEMORY_CORE_AGENT_ID", MEMORY_CORE_ENV_ONLY_ENV] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of MEM_ENV) saved[k] = process.env[k];
    // The api-agent tool registry resolves MemoryCore exactly as production
    // does (resolveMemoryCoreConfig): token from env, no OS keychain.
    process.env[MEMORY_CORE_ENV_ONLY_ENV] = "1";
    process.env.CONTINUUM_MEMORY_CORE_URL = "http://memcore.test";
    process.env.CONTINUUM_MEMORY_CORE_TOKEN = "tok";
    process.env.CONTINUUM_MEMORY_CORE_AGENT_ID = "default";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of MEM_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function recordingMemoryFetch() {
    const requests: Array<{ path: string; agentId: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string> }) => {
      requests.push({ path: new URL(url).pathname, agentId: init.headers?.["x-tdai-agent-id"] ?? null });
      return { ok: true, status: 200, json: async () => ({ data: { content: "", entries: [], items: [] } }), text: async () => "{}" };
    });
    return requests;
  }

  it("passes prep.projectScope to buildToolRegistry so memory_recall hits the per-project bucket, never 'default'", async () => {
    const requests = recordingMemoryFetch();
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({
      registerOrnith: true,
      chain: ["glm-5-2-free", "deepseek"],
      memoryCore: { baseUrl: "http://memcore.test", serviceToken: { envVar: "T" }, serviceId: "s", teamId: "team", userId: "u", agentId: "default", resolveToken: async () => "tok" },
      ensureLocalService: async () => ({ kind: "reused-foreign", host: "127.0.0.1", port: 8080 }),
    });
    const project = await registry.add({ name: "passcars-like", path: mkdtempSync(join(tmpdir(), "cont-mem-")) });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch(
      { projectKey: project.id, providerId: "local-ornith15", taskGoal: "hello" },
      { permissionMode: "safe" },
    );
    expect(launchPrep.runtimeKind).toBe("api");
    expect(launchPrep.projectScope).toBe(project.id);

    mockedRun.mockResolvedValueOnce({ finalContent: "hi" } as never);
    const { out } = collectOut();
    await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out, async () => ({ exitCode: 0 }));

    // The EXACT tool registry the api-agent received.
    const tools = mockedRun.mock.calls.at(-1)![0].tools;
    requests.length = 0;
    await tools.call("memory_recall", {});
    await tools.call("memory_search", { query: "anything" });

    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.agentId).toBe(`project-${project.id}`);
      expect(r.agentId).not.toBe("default");
    }
  });

  it("general-mode Direct-API keeps the base identity (intentional, unchanged)", async () => {
    const requests = recordingMemoryFetch();
    const { deps, sessionManager, dataDir } = await buildFallbackDeps({
      registerOrnith: true,
      memoryCore: { baseUrl: "http://memcore.test", serviceToken: { envVar: "T" }, serviceId: "s", teamId: "team", userId: "u", agentId: "default", resolveToken: async () => "tok" },
      ensureLocalService: async () => ({ kind: "reused-foreign", host: "127.0.0.1", port: 8080 }),
    });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch(
      { mode: "general", cwd: mkdtempSync(join(tmpdir(), "cont-gen-")), providerId: "local-ornith15", taskGoal: "hello" },
      { permissionMode: "safe" },
    );
    expect(launchPrep.projectScope).toBeUndefined();

    mockedRun.mockResolvedValueOnce({ finalContent: "hi" } as never);
    const { out } = collectOut();
    await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out, async () => ({ exitCode: 0 }));
    const tools = mockedRun.mock.calls.at(-1)![0].tools;
    requests.length = 0;
    await tools.call("memory_recall", {});
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.agentId).toBe("default");
  });
});

// ── Stale project defaultProvider migration ──────────────────────────────
describe("project defaultProvider migration (local-qwen38 → local-ornith15)", () => {
  it("canonicalizes a retired provider alias via the registry's atomic write path", async () => {
    const { registry } = await buildFallbackDeps({ registerOrnith: true });
    const stale = await registry.add({ name: "legacy", path: "/work/legacy", defaultProvider: "local-qwen38" });
    const untouched = await registry.add({ name: "kept", path: "/work/kept", defaultProvider: "claude" });

    const changed = await registry.migrateProviderIds((id) => {
      // mirror buildLauncherContext: providers.canonicalId
      return id === "local-qwen38" ? "local-ornith15" : id;
    });

    expect(changed).toEqual([stale.id]);
    expect((await registry.resolve(stale.id)).defaultProvider).toBe("local-ornith15");
    expect((await registry.resolve(untouched.id)).defaultProvider).toBe("claude");

    // Idempotent: a second run performs no write.
    expect(await registry.migrateProviderIds((id) => id)).toEqual([]);
  });
});
