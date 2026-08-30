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
import { codexProfile } from "../../providers/profiles/codex.js";
import { antigravityProfile } from "../../providers/profiles/antigravity.js";
import { oxAlphaManifest } from "../../providers/presets.js";
import { manifestToProfile, manifestToAuthMetadata } from "../../providers/manifest.js";
import type { ProviderManifest } from "../../providers/manifest.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { CliAuthAdapter, CredentialBackend, ProviderAuthMetadata } from "../../auth/types.js";
import type { LaunchRoute, ProviderProfile } from "../../providers/types.js";
import type { DiscoveredModel } from "../../providers/model-discovery.js";

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
  return mkdtempSync(join(tmpdir(), "continuum-perm-"));
}

function fakeCliAdapter(providerId: string, authenticated = true): CliAuthAdapter {
  return {
    providerId,
    capability: claudeProfile.cliLaunch as never,
    async detectInstalled() {
      return "installed";
    },
    async detectAuthenticated() {
      return authenticated ? "authenticated" : "not-authenticated";
    },
    async login() {
      return { completed: true, exitCode: 0 };
    },
    async logout() {
      return { completed: true, exitCode: 0 };
    },
  };
}

/** Fixed live model lists so discovery is deterministic (never touches real CLIs). */
const LIVE_MODELS = {
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Solution" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  ],
  antigravity: [
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash High" },
    { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash Medium" },
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash Low" },
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro High" },
  ],
} satisfies Record<string, readonly DiscoveredModel[]>;

async function buildDeps(opts: {
  discoverModels?: (profile: ProviderProfile) => Promise<readonly DiscoveredModel[]>;
  /** Force a dual-route provider (DeepSeek) onto its proxy route for this run. */
  route?: LaunchRoute;
  /** A custom provider manifest to register alongside the bundled ones (metadata + CLI auth + credential). */
  customManifest?: ProviderManifest;
  /** Override executable detection (e.g. no CLI at all → the direct-API harness). */
  findExecutable?: (executable: string) => string | undefined;
} = {}): Promise<{ deps: LauncherDeps; registry: ProjectRegistry; sessionManager: SessionManager; cliAuthManager: CliAuthManager; credentialManager: CredentialManager }> {
  const dataDir = tmp();
  const sessionDir = tmp();
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(codexProfile));
  providers.register(createProviderAdapter(antigravityProfile));
  providers.register(createProviderAdapter(manifestToProfile(oxAlphaManifest)));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  await credentialManager.setCredential("deepseek", "api-key", "sk-test");
  await credentialManager.setCredential("deepseek", "proxy-user-key", "pk-test");
  await credentialManager.setCredential("ox-alpha", "api-key", "sk-ox-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));
  cliAuthManager.register(fakeCliAdapter("codex"));
  cliAuthManager.register(fakeCliAdapter("antigravity"));

  const authMetadata = new Map(createDefaultProviderAuthMetadata());
  if (opts.customManifest) {
    const custom = opts.customManifest;
    providers.register(createProviderAdapter(manifestToProfile(custom)));
    authMetadata.set(custom.id, manifestToAuthMetadata(custom));
    if (custom.cli) cliAuthManager.register(fakeCliAdapter(custom.id));
    if (custom.auth.kind === "api-key") await credentialManager.setCredential(custom.id, "api-key", "sk-custom");
  }

  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));
  const forcedRoute = opts.route;

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
    // Deterministic by default so a model alias never runs the real CLI in tests.
    discoverModels: opts.discoverModels ?? (async (profile: ProviderProfile) => (LIVE_MODELS as Record<string, readonly DiscoveredModel[]>)[profile.id] ?? []),
    // Deterministic CLI detection: never depends on the real machine's PATH.
    findExecutable: opts.findExecutable ?? ((e: string) => (e === "claude" || e === "codex" || e === "agy" ? `/fake/${e}` : undefined)),
    ...(forcedRoute ? { getProviderRoute: (_providerId: string) => forcedRoute } : {}),
  };
  return { deps, registry, sessionManager, cliAuthManager, credentialManager };
}

const CODX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const CC_BYPASS = "--dangerously-skip-permissions";

describe("permission mode — global bypass default", () => {
  it("every CLI provider with a declared bypass flag defaults to FULL ACCESS on fresh launch", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);

    const claude = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D1", path: "/w/D1", defaultProvider: "claude" })).id, taskGoal: "ship" }, {});
    expect(claude.plan.bypassPermissions).toBe(true);
    expect(claude.plan.args).toContain(CC_BYPASS);
    expect(claude.permissionNote).toBeUndefined();

    const ds = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D2", path: "/w/D2", defaultProvider: "deepseek" })).id, providerId: "deepseek", taskGoal: "ship" }, {});
    expect(ds.plan.bypassPermissions).toBe(true);
    expect(ds.plan.args).toContain(CC_BYPASS);
    expect(ds.permissionNote).toBeUndefined();

    const codex = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, taskGoal: "ship" }, {});
    expect(codex.plan.bypassPermissions).toBe(true);
    expect(codex.plan.args).toContain(CODX_BYPASS);
    expect(codex.permissionNote).toBeUndefined();

    const agy = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, taskGoal: "ship" }, {});
    expect(agy.plan.bypassPermissions).toBe(true);
    expect(agy.plan.args).toContain(CC_BYPASS);
    expect(agy.permissionNote).toBeUndefined();
  });

  it("DeepSeek proxy route also defaults to FULL ACCESS (same verified Claude Code flag)", async () => {
    const { deps, registry } = await buildDeps({ route: "proxy" });
    const launcher = new Launcher(deps);
    const ds = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D2", path: "/w/D2", defaultProvider: "deepseek" })).id, providerId: "deepseek", taskGoal: "ship" }, {});
    expect(ds.route).toBe("proxy");
    expect(ds.plan.bypassPermissions).toBe(true);
    expect(ds.plan.args).toContain(CC_BYPASS);
    // The bare config-dir name is resolved to an absolute home path in the plan.
    expect(ds.plan.configDir).toContain(".claude-tencent");
  });

  it("explicit --safe suppresses bypass for every applicable provider (no flag emitted)", async () => {
    const { deps, registry } = await buildDeps({ route: "proxy" });
    const launcher = new Launcher(deps);
    for (const [name, providerId] of [
      ["claude", "claude"],
      ["deepseek", "deepseek"],
      ["deepseek-proxy", "deepseek"],
      ["codex", "codex"],
      ["antigravity", "antigravity"],
    ] as const) {
      const prep = await launcher.prepareLaunch({ projectKey: (await registry.add({ name, path: `/w/${name}`, defaultProvider: providerId })).id, providerId, taskGoal: "ship" }, { permissionMode: "safe" });
      expect(prep.plan.bypassPermissions).toBe(false);
      expect(prep.plan.args).not.toContain("--dangerously");
    }
  });

  it("a requested bypass on a CLI provider with NO declared flag surfaces a visible note, never an invented flag", async () => {
    const custom: ProviderManifest = {
      schemaVersion: 1,
      id: "custom-cli",
      displayName: "Custom CLI",
      protocol: "anthropic-messages",
      baseUrl: "https://example.com",
      auth: { kind: "cli-session" },
      models: { default: "m1" },
      cliLaunch: { kind: "native", clearEnvVars: [] },
      cli: { supported: true, executable: "custom", versionArgs: ["--version"], loginArgs: ["login"] },
    };
    const { deps, registry } = await buildDeps({ customManifest: custom });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "Z1", path: "/w/Z1", defaultProvider: "custom-cli" })).id, taskGoal: "ship" }, {});
    expect(prep.plan.bypassPermissions).toBe(false);
    expect(prep.plan.args).not.toContain("--dangerously");
    expect(prep.permissionNote).toContain("custom-cli");
    expect(prep.permissionNote).toContain("no native full-access flag");
  });

  it("API runtime emits no CLI bypass flag and no FULL ACCESS claim", async () => {
    // Ox Alpha with the claude executable missing → the direct-API harness.
    const { deps, registry } = await buildDeps({
      findExecutable: () => undefined,
    });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "O1", path: "/w/O1", defaultProvider: "ox-alpha" })).id, providerId: "ox-alpha", taskGoal: "ship" }, {});
    expect(prep.runtimeKind).toBe("api");
    expect(prep.plan.bypassPermissions).toBe(false);
    expect(prep.plan.args).not.toContain("--dangerously");
    expect(prep.permissionNote).toBeUndefined();
  });
});

describe("permission + model reach the native CLI on fresh launch", () => {
  it("Claude fresh launch carries the bypass flag before session/context args", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D1", path: "/w/D1", defaultProvider: "claude" })).id, taskGoal: "ship it" }, {});
    expect(prep.plan.args[0]).toBe(CC_BYPASS);
    expect(prep.plan.args).toContain("--session-id");
    expect(prep.plan.args.filter((a) => a === CC_BYPASS)).toHaveLength(1);
  });

  it("DeepSeek direct fresh launch carries the bypass flag before session/context args", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D2", path: "/w/D2", defaultProvider: "deepseek" })).id, providerId: "deepseek", taskGoal: "ship it" }, {});
    expect(prep.plan.executable).toBe("claude");
    expect(prep.plan.args[0]).toBe(CC_BYPASS);
    expect(prep.plan.args).toContain("--session-id");
    expect(prep.plan.args.filter((a) => a === CC_BYPASS)).toHaveLength(1);
  });

  it("Antigravity fresh launch carries --model <id> + bypass before the prompt delivered via --prompt-interactive", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, modelAlias: "pro", taskGoal: "ship it" },
      {},
    );
    expect(prep.plan.args.slice(0, 3)).toEqual(["--model", "gemini-3.1-pro-high", CC_BYPASS]);
    expect(prep.plan.args).toHaveLength(5);
    expect(prep.plan.args[3]).toBe("--prompt-interactive");
    expect(prep.plan.args[4]).toContain("ship it");
  });

  it("Codex fresh launch carries -m <id> + bypass before the prompt-only positional", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, modelAlias: "terra", taskGoal: "ship it" },
      {},
    );
    expect(prep.plan.args.slice(0, 3)).toEqual(["-m", "gpt-5.6-terra", CODX_BYPASS]);
    expect(prep.plan.args).toHaveLength(4);
    expect(prep.plan.args[3]).toContain("ship it");
  });
});

describe("antigravity context delivery — interactive-flag (--prompt-interactive)", () => {
  it("new-task launch: the goal is a --prompt-interactive VALUE, never a positional arg", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "AG1", path: "/w/AG1", defaultProvider: "antigravity" })).id, taskGoal: "Inspect src/session" },
      {},
    );
    const args = prep.plan.args;
    expect(prep.plan.executable).toBe("agy");
    const flagIdx = args.indexOf("--prompt-interactive");
    expect(flagIdx).toBeGreaterThan(0);
    // The prompt value is the LAST arg and is preceded by the flag — a bare
    // positional would sit at the end with no flag ahead of it.
    expect(flagIdx).toBe(args.length - 2);
    expect(args[args.length - 1]).toContain("Inspect src/session");
  });

  it("resume launch: prompt via --prompt-interactive after --conversation <id>", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "AG2", path: "/w/AG2", defaultProvider: "antigravity" })).id, taskGoal: "ship" },
      {},
    );
    await launcher.recordNativeSessionId(first.session!.sessionId, "antigravity", "agy-native-1");
    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    const args = resume.plan.args;
    const convIdx = args.indexOf("--conversation");
    expect(convIdx).toBeGreaterThan(0);
    expect(args[convIdx + 1]).toBe("agy-native-1");
    expect(args[args.length - 2]).toBe("--prompt-interactive");
    expect(args[args.length - 1]).toContain("ship");
  });

  it("blank optional task goal → bare launch with no prompt flag (agy TUI opens empty)", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "AG3", path: "/w/AG3", defaultProvider: "antigravity" })).id, taskGoal: "" },
      {},
    );
    expect(prep.plan.args).not.toContain("--prompt-interactive");
    expect(prep.plan.args[0]).toBe("--model");
  });

  it("multiline handoff prompt reaches the --prompt-interactive value intact through the launcher", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "AG4", path: "/w/AG4", defaultProvider: "antigravity" })).id, taskGoal: "ship the thing" },
      {},
    );
    await sessionManager.addCompletedWork(first.session!.sessionId, "built the core");
    await sessionManager.recordDecision(first.session!.sessionId, "use snapshot testing");

    const handoff = await launcher.prepareLaunch({ sessionId: first.session!.sessionId, providerId: "antigravity" }, {});
    const args = handoff.plan.args;
    const flagIdx = args.indexOf("--prompt-interactive");
    const value = args[flagIdx + 1]!;
    expect(value).toContain("<handoff-resume>");
    expect(value).toContain("Do not re-audit");
    expect(value).toContain("built the core");
    expect(value).toContain("use snapshot testing");
    expect(value).toContain("ship the thing");
    // The whole block is the flag value (nothing follows it) — agy rejects any
    // positional, so the value must not leak out as a trailing arg.
    expect(flagIdx).toBe(args.length - 2);
  });
});

describe("permission survives resume and handoff-receiving launches", () => {
  it("Claude resume carries the bypass flag before --resume <id>", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D1", path: "/w/D1", defaultProvider: "claude" })).id, taskGoal: "ship" }, {});
    await sessionManager.recordNativeSessionId(first.session!.sessionId, "claude", "native-1");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    expect(resume.plan.bypassPermissions).toBe(true);
    expect(resume.plan.args.slice(0, 3)).toEqual([CC_BYPASS, "--resume", "native-1"]);
    expect(resume.plan.args.filter((a) => a === CC_BYPASS)).toHaveLength(1);
  });

  it("DeepSeek direct resume carries the bypass flag before --resume <id>", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D2", path: "/w/D2", defaultProvider: "deepseek" })).id, providerId: "deepseek", taskGoal: "ship" }, {});
    await sessionManager.recordNativeSessionId(first.session!.sessionId, "deepseek", "native-2");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    expect(resume.plan.bypassPermissions).toBe(true);
    expect(resume.plan.args.slice(0, 3)).toEqual([CC_BYPASS, "--resume", "native-2"]);
    expect(resume.plan.args.filter((a) => a === CC_BYPASS)).toHaveLength(1);
  });

  it("DeepSeek proxy resume carries the bypass flag before --resume <id>", async () => {
    const { deps, registry, sessionManager } = await buildDeps({ route: "proxy" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D2", path: "/w/D2", defaultProvider: "deepseek" })).id, providerId: "deepseek", taskGoal: "ship" }, {});
    await sessionManager.recordNativeSessionId(first.session!.sessionId, "deepseek", "native-3");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    expect(resume.route).toBe("proxy");
    expect(resume.plan.bypassPermissions).toBe(true);
    expect(resume.plan.args.slice(0, 3)).toEqual([CC_BYPASS, "--resume", "native-3"]);
    expect(resume.plan.args.filter((a) => a === CC_BYPASS)).toHaveLength(1);
  });

  it("Antigravity resume carries --model (preserved), bypass, and --conversation <id>", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, modelAlias: "high", taskGoal: "ship" },
      {},
    );
    await sessionManager.recordNativeSessionId(first.session!.sessionId, "antigravity", "conv-777");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    expect(resume.plan.args.slice(0, 5)).toEqual(["--model", "gemini-3.7-flash-high", CC_BYPASS, "--conversation", "conv-777"]);
    expect(resume.plan.args[5]).toBe("--prompt-interactive");
    expect(resume.plan.args[6]).toContain("ship");
    expect(resume.nativeResume).toEqual({ providerId: "antigravity", nativeSessionId: "conv-777" });
  });

  it("Codex resume carries -m (preserved), bypass, and the resume subcommand", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, modelAlias: "terra", taskGoal: "ship" },
      {},
    );
    await sessionManager.recordNativeSessionId(first.session!.sessionId, "codex", "codex-native-9");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    expect(resume.plan.args.slice(0, 5)).toEqual(["-m", "gpt-5.6-terra", CODX_BYPASS, "resume", "codex-native-9"]);
    expect(resume.plan.args[5]).toContain("ship");
    expect(resume.nativeResume).toEqual({ providerId: "codex", nativeSessionId: "codex-native-9" });
  });

  it("the bypass flag appears exactly once and before the resume token where required", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, modelAlias: "terra", taskGoal: "ship" },
      {},
    );
    await sessionManager.recordNativeSessionId(first.session!.sessionId, "codex", "codex-native-9");
    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    const flags = resume.plan.args.filter((a) => a === CODX_BYPASS);
    expect(flags).toHaveLength(1);
    expect(resume.plan.args.indexOf(CODX_BYPASS)).toBeLessThan(resume.plan.args.indexOf("resume"));
  });

  it("handoff-receiving launch inherits the receiving provider's bypass default", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "D1", path: "/w/D1", defaultProvider: "claude" })).id, taskGoal: "ship" },
      { permissionMode: "safe" },
    );
    // Claude → Antigravity: the receiving launch defaults to full access.
    const handoff = await launcher.prepareLaunch({ sessionId: first.session!.sessionId, providerId: "antigravity" }, {});
    expect(handoff.providerRef.providerId).toBe("antigravity");
    expect(handoff.plan.bypassPermissions).toBe(true);
    expect(handoff.plan.args).toContain(CC_BYPASS);
  });
});

describe("discovery-aware model resolution", () => {
  it("a live model id passes through verbatim (never remapped)", async () => {
    const { deps, registry } = await buildDeps({ discoverModels: async () => LIVE_MODELS.antigravity });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, modelAlias: "gemini-3.7-flash-medium", taskGoal: "ship" },
      {},
    );
    expect(prep.providerRef.model).toBe("gemini-3.7-flash-medium");
    expect(prep.plan.args.slice(0, 2)).toEqual(["--model", "gemini-3.7-flash-medium"]);
    expect(prep.modelNote).toBeUndefined();
  });

  it("a selected model that vanished from the live list falls back to the default with an explicit note", async () => {
    // Live list no longer carries gpt-5.4-mini (the target of the `mini` alias) —
    // as if a CLI update dropped it.
    const stale = LIVE_MODELS.codex.filter((m) => m.id !== "gpt-5.4-mini");
    const { deps, registry } = await buildDeps({ discoverModels: async () => stale });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, modelAlias: "mini", taskGoal: "ship" },
      {},
    );
    expect(prep.providerRef.model).toBe("gpt-5.6-sol");
    expect(prep.modelNote).toContain("gpt-5.4-mini");
    expect(prep.plan.args.slice(0, 2)).toEqual(["-m", "gpt-5.6-sol"]);
  });

  it("a raw model id that is neither an alias nor in the live list fails clearly (never silently ignored)", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    await expect(
      launcher.prepareLaunch(
        { projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, modelAlias: "gpt-5.6-omega", taskGoal: "ship" },
        {},
      ),
    ).rejects.toThrow(/no model mapping for alias "gpt-5.6-omega"/);
  });

  it("discovery failure degrades to the manifest list (no error, no note, model passes through)", async () => {
    const { deps, registry } = await buildDeps({
      discoverModels: async () => {
        throw new Error("cli not found");
      },
    });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, modelAlias: "mini", taskGoal: "ship" },
      {},
    );
    expect(prep.providerRef.model).toBe("gpt-5.4-mini");
    expect(prep.modelNote).toBeUndefined();
  });
});
