import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Launcher } from "../launcher.js";
import { CompatProxyUnavailableError } from "../errors.js";
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
import { launchPrepared } from "../../cli/commands/launch.js";
import type { LauncherDeps } from "../launcher.js";
import type { LaunchPlan } from "../types.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";
import type { CompatProxySpec } from "../../providers/types.js";
import type { CompatProxyReadiness } from "../../providers/deepseek-compat-proxy.js";

type EnsureCompatProxyFn = (spec: CompatProxySpec, onProgress?: (line: string) => void) => Promise<CompatProxyReadiness>;
type SpawnFn = (plan: LaunchPlan) => Promise<{ exitCode: number | null; stderrTail?: string }>;

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
  ensureCompatProxy: ReturnType<typeof vi.fn>;
  order: string[];
}

async function setup(opts: { defaultProvider?: "deepseek" | "claude"; ensureReady?: boolean } = {}): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "cp-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "cps-"));
  const repoDir = mkdtempSync(join(tmpdir(), "cprepo-"));
  execSync("git init -q", { cwd: repoDir });
  execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repoDir });

  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude", true));
  await credentialManager.setCredential("deepseek", "api-key", "sk-ds-api");

  const authMetadata = createDefaultProviderAuthMetadata();
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));

  const order: string[] = [];
  const ensureCompatProxy = vi.fn<EnsureCompatProxyFn>(async (_spec) => {
    order.push("ensureCompatProxy");
    return { ready: opts.ensureReady ?? true };
  });

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
    ensureCompatProxy,
  };

  const defaultProvider = opts.defaultProvider ?? "deepseek";
  await registry.add({ name: "p", path: repoDir, defaultProvider });

  return { deps, backend, registry, sessionManager, repoDir, ensureCompatProxy, order };
}

describe("DeepSeek compatibility-proxy launch gate", () => {
  it("ensures the compat proxy BEFORE the CLI is spawned and routes the plan through it", async () => {
    const { deps, registry, repoDir, ensureCompatProxy, order } = await setup();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" });

    // Gate ran during prepareLaunch (i.e. before any spawn can happen).
    expect(ensureCompatProxy).toHaveBeenCalledTimes(1);
    expect(ensureCompatProxy.mock.calls[0]![0]).toMatchObject({
      host: "127.0.0.1",
      port: 8177,
      cliPathSuffix: "/anthropic",
      upstreamBaseUrl: "https://api.deepseek.com",
    });
    expect(prep.plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8177/anthropic");

    // Full ordering proof: ensure → spawn, never the reverse.
    const spawnFn = vi.fn<SpawnFn>(async () => {
      order.push("spawn");
      return { exitCode: 0 };
    });
    const exit = await launchPrepared(
      { launcher, providers: deps.providers, sessionManager: deps.sessionManager, dataDir: join(repoDir, "unused") },
      prep,
      () => {},
      spawnFn,
    );
    expect(exit).toBe(0);
    expect(order).toEqual(["ensureCompatProxy", "spawn"]);
    expect(spawnFn.mock.calls[0]![0].env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8177/anthropic");
  });

  it("fails the launch clearly when the compat proxy is unavailable — never a silent direct fallback", async () => {
    const { deps, sessionManager } = await setup({ ensureReady: false });
    const launcher = new Launcher(deps);
    await expect(launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" })).rejects.toMatchObject({
      code: "compat-proxy-unavailable",
      name: "CompatProxyUnavailableError",
    });
    await expect(launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" })).rejects.toThrowError(
      /Launching directly would reintroduce the known HTTP 400 Artifact-schema failure/,
    );
    // No session was created or mutated by the failed launch.
    expect(await sessionManager.listSessionIds()).toEqual([]);
  });

  it("does not engage the gate for non-DeepSeek providers", async () => {
    const { deps, registry, repoDir, ensureCompatProxy } = await setup({ defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" });
    expect(prep.plan.providerId).toBe("claude");
    expect(ensureCompatProxy).not.toHaveBeenCalled();
    expect(prep.plan.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("leaves DeepSeek model routing unchanged (flash-by-default tiers, catalog-facing identity env)", async () => {
    const { deps } = await setup();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: "p" }, { permissionMode: "safe" });
    expect(prep.plan.model).toBe("deepseek-flash");
    const settingsIndex = prep.plan.args.indexOf("--settings");
    const settings = JSON.parse(prep.plan.args[settingsIndex + 1] ?? "{}");
    expect(settings.modelOverrides).toEqual({
      "claude-sonnet-5": "deepseek-flash",
      "claude-opus-5": "deepseek-flash",
      "claude-haiku-4-5": "deepseek-flash",
      "claude-fable-5": "deepseek-flash",
    });
    expect(prep.plan.env.ANTHROPIC_MODEL).toBe("sonnet");
    expect(prep.plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-flash");
    expect(prep.plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-flash");
  });
});
