import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchPlan } from "../types.js";

/**
 * Proves what actually gets spawned — the executable + the FINAL child env
 * after both `plan.env` and `plan.clearEnvVars` are applied — not just the
 * `LaunchPlan` object a provider adapter builds. This is the layer where a
 * previous regression silently deleted DeepSeek's own ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN redirect immediately after setting them (clearEnvVars
 * ran after plan.env, and DeepSeek's redirected/proxy launch descriptors
 * clear the exact two vars they set), so the spawned `claude` binary fell
 * through to native Claude behavior even though DeepSeek was selected.
 */

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
  }
}

let lastSpawnCall: { command: string; args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } } | undefined;
let fakeChild: FakeChildProcess;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      lastSpawnCall = { command, args, options };
      fakeChild = new FakeChildProcess();
      queueMicrotask(() => fakeChild.emit("close", 0));
      return fakeChild;
    },
  };
});

const { spawnCli } = await import("../spawn.js");
const { Launcher } = await import("../launcher.js");
const { ProjectRegistry } = await import("../../registry/registry.js");
const { ProjectRegistryStore } = await import("../../registry/store.js");
const { ProviderRegistry } = await import("../../providers/registry.js");
const { createProviderAdapter } = await import("../../providers/adapter.js");
const { claudeProfile } = await import("../../providers/profiles/claude.js");
const { deepseekProfile } = await import("../../providers/profiles/deepseek.js");
const { CredentialManager } = await import("../../auth/credential-manager.js");
const { CliAuthManager } = await import("../../auth/cli-auth-manager.js");
const { AuthVerifier } = await import("../../auth/auth-verifier.js");
const { SessionManager } = await import("../../session/manager.js");
const { FileSessionStore } = await import("../../session/store.js");
const { createDefaultProviderAuthMetadata } = await import("../../auth/provider-auth/index.js");
const { createScriptedPrompt } = await import("../../auth/prompt.js");
type CliAuthAdapter = import("../../auth/types.js").CliAuthAdapter;
type CredentialBackend = import("../../auth/types.js").CredentialBackend;
type LauncherDeps = import("../launcher.js").LauncherDeps;

function plan(overrides: Partial<LaunchPlan>): LaunchPlan {
  return {
    providerId: "test",
    model: "test-model",
    executable: "claude",
    args: [],
    env: {},
    clearEnvVars: [],
    workingDir: "/tmp",
    bypassPermissions: false,
    ...overrides,
  };
}

const ORIGINAL_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ORIGINAL_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;

beforeEach(() => {
  lastSpawnCall = undefined;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = ORIGINAL_BASE_URL;
  if (ORIGINAL_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
});

describe("spawnCli — actual spawned executable/env, not just the LaunchPlan", () => {
  it("DeepSeek redirected launch: the child process actually receives DeepSeek's endpoint + token", async () => {
    // Mirrors deepseekManifest.cliLaunch exactly: env sets the redirect, and
    // clearEnvVars lists the SAME two vars (meant to strip stale inherited
    // values from a prior shell export — never to undo this launch's own env).
    const deepseekPlan = plan({
      providerId: "deepseek",
      executable: "claude",
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-deepseek-fixture-token",
      },
      clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
      configDir: ".claude-deepseek",
    });

    await spawnCli(deepseekPlan);

    expect(lastSpawnCall?.command).toBe("claude");
    // The whole point of a redirected launch: these must survive to the
    // actually-spawned child, not just to the intermediate LaunchPlan.
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-fixture-token");
  });

  it("DeepSeek proxy-routed launch: the child process actually receives the proxy endpoint + proxy key", async () => {
    const proxyPlan = plan({
      providerId: "deepseek",
      executable: "claude",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8096/claude-code/default",
        ANTHROPIC_AUTH_TOKEN: "sk-mem-fixture-proxy-key",
      },
      clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
      configDir: ".claude-tencent",
    });

    await spawnCli(proxyPlan);

    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8096/claude-code/default");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-mem-fixture-proxy-key");
  });

  it("clearEnvVars still strips a stale inherited value that the plan does NOT re-set", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://stale-leftover-from-a-previous-shell-export";
    const claudePlan = plan({
      providerId: "claude",
      executable: "claude",
      env: {},
      clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
      configDir: ".claude-anthropic",
    });

    await spawnCli(claudePlan);

    // Native Claude must never inherit a stale redirect from a prior DeepSeek run.
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("a plan-set var always wins over an inherited value with the same name", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://stale-leftover-from-a-previous-shell-export";
    const deepseekPlan = plan({
      providerId: "deepseek",
      executable: "claude",
      env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-deepseek-fixture" },
      clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    });

    await spawnCli(deepseekPlan);

    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
  });
});

/**
 * Full pipeline: real `Launcher.prepareLaunch` (real Claude/DeepSeek
 * `ProviderAdapter`s, real manifest-derived launch descriptors) → real
 * `spawnCli`. Not a synthetic `LaunchPlan` — this is what a fresh launch,
 * a resume, and a handoff in either direction actually produce at the
 * moment a process would be spawned. Guards against a second regression in
 * this same area (routing was proven correct end-to-end against a live
 * `claude` process + DeepSeek's real API in this incident; these tests keep
 * that guarantee enforced in CI without needing live credentials).
 */
class FakeCredentialBackend implements CredentialBackend {
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

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "continuum-spawn-e2e-"));
}

function fakeCliAdapter(providerId: string): CliAuthAdapter {
  return {
    providerId,
    capability: claudeProfile.cliLaunch as never,
    async detectInstalled() {
      return "installed";
    },
    async detectAuthenticated() {
      return "authenticated";
    },
    async login() {
      return { completed: true, exitCode: 0 };
    },
    async logout() {
      return { completed: true, exitCode: 0 };
    },
  };
}

async function buildRealLauncher(): Promise<InstanceType<typeof Launcher>> {
  const dataDir = tmpDir();
  const sessionDir = tmpDir();

  const projects = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));

  const backend = new FakeCredentialBackend();
  const credentialManager = new CredentialManager(backend);
  await credentialManager.setCredential("deepseek", "api-key", "sk-deepseek-real-fixture-key");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));

  const authMetadata = createDefaultProviderAuthMetadata();
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));

  const deps: LauncherDeps = {
    projects,
    providers,
    credentialManager,
    cliAuthManager,
    authVerifier,
    authMetadata,
    sessionManager,
    prompt: createScriptedPrompt({}),
    sessionBaseDir: sessionDir,
  } satisfies LauncherDeps;

  return new Launcher(deps);
}

describe("spawnCli — full launcher-to-spawn pipeline (real adapters, real prepareLaunch)", () => {
  it("fresh DeepSeek launch: real prepareLaunch → real spawnCli receives DeepSeek's redirect", async () => {
    const launcher = await buildRealLauncher();
    const prep = await launcher.prepareLaunch({ mode: "current-directory", providerId: "deepseek", cwd: "/tmp" }, { permissionMode: "safe" });

    await spawnCli(prep.plan);

    expect(lastSpawnCall?.command).toBe("claude");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-real-fixture-key");
    expect(lastSpawnCall?.options.env?.CLAUDE_CONFIG_DIR).toContain(".claude-deepseek");
    // Model identity: without these, Claude Code's own default tier models
    // (e.g. "Opus 5") silently leak through even though every request is
    // redirected to DeepSeek — this is the exact mechanism behind that bug.
    // DeepSeek implicit Claude tiers are Flash-only; Pro requires explicit choice.
    // sonnet/haiku/subagent map to "flash" (see providers/presets.ts).
    expect(lastSpawnCall?.options.env?.ANTHROPIC_MODEL).toBe("sonnet");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5");
    expect(lastSpawnCall?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-sonnet-5");
  });

  it("DeepSeek existing-session resume: same redirect AND model identity survive to spawn on the resume path", async () => {
    const launcher = await buildRealLauncher();
    const first = await launcher.prepareLaunch({ mode: "current-directory", providerId: "deepseek", cwd: "/tmp" }, { permissionMode: "safe" });
    const resumed = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });

    await spawnCli(resumed.plan);

    expect(resumed.providerRef.providerId).toBe("deepseek");
    expect(resumed.providerRef.model).toBe("deepseek-v4-flash");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-real-fixture-key");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_MODEL).toBe("sonnet");
    expect(lastSpawnCall?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-sonnet-5");
  });

  it("Claude fresh launch: real spawnCli receives no redirect and NO DeepSeek model overrides (native tiers stay native)", async () => {
    const launcher = await buildRealLauncher();
    const prep = await launcher.prepareLaunch({ mode: "current-directory", providerId: "claude", cwd: "/tmp" }, { permissionMode: "safe" });

    await spawnCli(prep.plan);

    expect(lastSpawnCall?.command).toBe("claude");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(lastSpawnCall?.options.env?.CLAUDE_CONFIG_DIR).toContain(".claude-anthropic");
    // Native Claude must never get DeepSeek's model-tier remap — Claude's own
    // Opus/Sonnet/Haiku defaults are correct here and must be left alone.
    expect(lastSpawnCall?.options.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it("Claude → DeepSeek handoff: the same session, resumed onto DeepSeek, spawns with DeepSeek's redirect AND model identity applied cleanly", async () => {
    const launcher = await buildRealLauncher();
    const claudeLaunch = await launcher.prepareLaunch({ mode: "current-directory", providerId: "claude", cwd: "/tmp" }, { permissionMode: "safe" });
    await spawnCli(claudeLaunch.plan);
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_MODEL).toBeUndefined();

    const handedOff = await launcher.prepareLaunch(
      { sessionId: claudeLaunch.session!.sessionId, providerId: "deepseek" },
      { permissionMode: "safe" },
    );
    await spawnCli(handedOff.plan);

    expect(handedOff.providerRef.providerId).toBe("deepseek");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-real-fixture-key");
    expect(lastSpawnCall?.options.env?.CLAUDE_CONFIG_DIR).toContain(".claude-deepseek");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_MODEL).toBe("sonnet");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5");
    expect(lastSpawnCall?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-sonnet-5");
  });

  it("DeepSeek → Claude handoff: the same session, resumed onto Claude, spawns with NO leftover DeepSeek redirect or model overrides", async () => {
    const launcher = await buildRealLauncher();
    const deepseekLaunch = await launcher.prepareLaunch({ mode: "current-directory", providerId: "deepseek", cwd: "/tmp" }, { permissionMode: "safe" });
    await spawnCli(deepseekLaunch.plan);
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_MODEL).toBe("sonnet");

    const handedOff = await launcher.prepareLaunch(
      { sessionId: deepseekLaunch.session!.sessionId, providerId: "claude" },
      { permissionMode: "safe" },
    );
    await spawnCli(handedOff.plan);

    expect(handedOff.providerRef.providerId).toBe("claude");
    // The critical assertion: Claude's spawn must NEVER inherit DeepSeek's
    // redirect or model overrides, whether from process.env or cross-call
    // state — clearEnvVars must win here since Claude's plan.env sets none
    // of these itself.
    expect(lastSpawnCall?.options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(lastSpawnCall?.options.env?.CLAUDE_CONFIG_DIR).toContain(".claude-anthropic");
    expect(lastSpawnCall?.options.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(lastSpawnCall?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it("DeepSeek 'pro' model override: primary ANTHROPIC_MODEL follows an explicit non-default choice, tier map stays fixed to the two real DeepSeek models", async () => {
    // DeepSeek's default model is "flash"; the PRIMARY ANTHROPIC_MODEL must
    // follow an explicit "pro" override (not silently stay on the default),
    // while the opus/sonnet/haiku/subagent tier map is unaffected (it always
    // maps to the same two real DeepSeek models regardless of the session's
    // own primary-model choice).
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/tmp", modelAlias: "pro", secrets: { DEEPSEEK_API_KEY: "sk-deepseek-real-fixture-key" } });

    expect(plan.env.ANTHROPIC_MODEL).toBe("sonnet");
    expect(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5");
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-sonnet-5");
  });

  it("DeepSeek config dir isolation: DeepSeek and Claude never share a CLAUDE_CONFIG_DIR across spawns", async () => {
    const launcher = await buildRealLauncher();
    const deepseekLaunch = await launcher.prepareLaunch({ mode: "current-directory", providerId: "deepseek", cwd: "/tmp" }, { permissionMode: "safe" });
    await spawnCli(deepseekLaunch.plan);
    const deepseekConfigDir = lastSpawnCall?.options.env?.CLAUDE_CONFIG_DIR;

    const claudeLaunch = await launcher.prepareLaunch({ mode: "current-directory", providerId: "claude", cwd: "/tmp" }, { permissionMode: "safe" });
    await spawnCli(claudeLaunch.plan);
    const claudeConfigDir = lastSpawnCall?.options.env?.CLAUDE_CONFIG_DIR;

    expect(deepseekConfigDir).toContain(".claude-deepseek");
    expect(claudeConfigDir).toContain(".claude-anthropic");
    expect(deepseekConfigDir).not.toBe(claudeConfigDir);
  });
});
