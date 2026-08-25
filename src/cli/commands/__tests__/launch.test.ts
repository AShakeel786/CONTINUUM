import { describe, expect, it, vi, beforeEach } from "vitest";
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
import { oxAlphaManifest } from "../../../providers/presets.js";
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

// ── Automatic-routing fallback (Ox Alpha Free → DeepSeek) ─────────────────

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
  readonly oxUsable?: boolean;
  readonly deepseekUsable?: boolean;
  readonly chain?: readonly string[];
  readonly extraProfiles?: readonly ProviderProfile[];
  readonly extraManifests?: readonly ProviderManifest[];
}

async function buildFallbackDeps(opts: FallbackDepsOpts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-fallback-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-fallback-sess-"));
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(manifestToProfile(oxAlphaManifest)));
  for (const profile of opts.extraProfiles ?? []) providers.register(createProviderAdapter(profile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  if (opts.deepseekUsable) await credentialManager.setCredential("deepseek", "api-key", "sk-ds-test");
  if (opts.oxUsable) await credentialManager.setCredential("ox-alpha", "api-key", "sk-ox-test");
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
    ...(opts.chain ? { preferredProviderChain: opts.chain } : {}),
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

  it("falls back to DeepSeek when the chain-routed Ox Alpha fails (rate-limit), and the session follows", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ oxUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.providerRef.providerId).toBe("ox-alpha");
    expect(launchPrep.autoRoute?.index).toBe(0);

    mockedRun.mockRejectedValueOnce(new ApiAgentError("rate-limited", { kind: "rate-limit" }));
    const { out, lines } = collectOut();
    let spawnedPlan: LaunchPlan | undefined;
    const exit = await launchPrepared(
      { launcher, providers: deps.providers, sessionManager, dataDir },
      launchPrep,
      out,
      async (plan) => { spawnedPlan = plan; return { exitCode: 0 }; },
    );

    expect(exit).toBe(0);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(spawnedPlan?.providerId).toBe("deepseek");
    expect(spawnedPlan?.model).toBe("deepseek-v4-flash");
    expect(lines.join("\n")).toContain("falling back to DeepSeek");
    expect(lines.join("\n")).toContain("automatic-fallback: ox-alpha → deepseek");
    // The API runner received the resolved auth env from the launch plan
    // (credential store value), not a process.env mutation.
    expect(mockedRun.mock.calls[0]![0].env).toEqual({ OPENROUTER_API_KEY: "sk-ox-test" });
    const session = await sessionManager.loadSession(launchPrep.session!.sessionId);
    expect(session.activeProvider.providerId).toBe("deepseek");
  });

  it("an explicit (non-chain-routed) launch never falls back — it fails fast", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ oxUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, providerId: "ox-alpha", taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.autoRoute).toBeUndefined();

    mockedRun.mockRejectedValueOnce(new ApiAgentError("rate-limited", { kind: "rate-limit" }));
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("Ox Alpha Free API connection failed");
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("fails fast when the chain has no usable fallback member", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ oxUsable: true }); // deepseek has no credential
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.providerRef.providerId).toBe("ox-alpha");

    mockedRun.mockRejectedValueOnce(new ApiAgentError("auth failed", { kind: "auth" }));
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("never falls back on a local (non-ApiAgentError) failure", async () => {
    const { deps, registry, sessionManager, dataDir } = await buildFallbackDeps({ oxUsable: true, deepseekUsable: true });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });

    mockedRun.mockRejectedValueOnce(new Error("local bug in tool registry"));
    const { out, lines } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("API agent error: local bug in tool registry");
    expect(lines.join("\n")).not.toContain("falling back");
  });

  it("loops through an API fallback provider and stops after its failure (no cascade)", async () => {
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
      oxUsable: true,
      chain: ["ox-alpha", "api-b"],
      extraManifests: [apiBManifest],
      extraProfiles: [manifestToProfile(apiBManifest)],
    });
    const project = await registry.add({ name: `fb-${Math.random().toString(36).slice(2, 8)}`, path: "/work/fb" });
    const launcher = new Launcher(deps);
    const launchPrep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "do it" }, { permissionMode: "safe" });
    expect(launchPrep.providerRef.providerId).toBe("ox-alpha");

    mockedRun.mockRejectedValue(new ApiAgentError("rate-limited", { kind: "rate-limit" }));
    const { out } = collectOut();
    const exit = await launchPrepared({ launcher, providers: deps.providers, sessionManager, dataDir }, launchPrep, out);

    expect(exit).toBe(1);
    expect(mockedRun).toHaveBeenCalledTimes(2);
    expect(mockedRun.mock.calls[0]![0].adapter.profile.id).toBe("ox-alpha");
    expect(mockedRun.mock.calls[1]![0].adapter.profile.id).toBe("api-b");
  });
});
