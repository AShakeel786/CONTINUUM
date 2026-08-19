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
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";
import type { ProviderProfile } from "../../providers/types.js";
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
} = {}): Promise<{ deps: LauncherDeps; registry: ProjectRegistry; sessionManager: SessionManager }> {
  const dataDir = tmp();
  const sessionDir = tmp();
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(codexProfile));
  providers.register(createProviderAdapter(antigravityProfile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  await credentialManager.setCredential("deepseek", "api-key", "sk-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));
  cliAuthManager.register(fakeCliAdapter("codex"));
  cliAuthManager.register(fakeCliAdapter("antigravity"));

  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));

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
    // Deterministic by default so a model alias never runs the real CLI in tests.
    discoverModels: opts.discoverModels ?? (async (profile: ProviderProfile) => (LIVE_MODELS as Record<string, readonly DiscoveredModel[]>)[profile.id] ?? []),
  };
  return { deps, registry, sessionManager };
}

const CODX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const AGY_BYPASS = "--dangerously-skip-permissions";

describe("permission mode — provider defaults", () => {
  it("Codex + Antigravity default to FULL ACCESS (bypass flag emitted); Claude/DeepSeek default to safe", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);

    const codex = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "C1", path: "/w/C1", defaultProvider: "codex" })).id, taskGoal: "ship" }, {});
    expect(codex.plan.bypassPermissions).toBe(true);
    expect(codex.plan.args).toContain(CODX_BYPASS);
    expect(codex.permissionNote).toBeUndefined();

    const agy = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, taskGoal: "ship" }, {});
    expect(agy.plan.bypassPermissions).toBe(true);
    expect(agy.plan.args).toContain(AGY_BYPASS);
    expect(agy.permissionNote).toBeUndefined();

    const claude = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D1", path: "/w/D1", defaultProvider: "claude" })).id, taskGoal: "ship" }, {});
    expect(claude.plan.bypassPermissions).toBe(false);
    expect(claude.plan.args).not.toContain("--dangerously");
    expect(claude.permissionNote).toBeUndefined();

    const ds = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D2", path: "/w/D2", defaultProvider: "deepseek" })).id, taskGoal: "ship" }, {});
    expect(ds.plan.bypassPermissions).toBe(false);
  });

  it("explicit --safe overrides the provider's bypass default (no bypass flag emitted)", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, taskGoal: "ship" }, { permissionMode: "safe" });
    expect(prep.plan.bypassPermissions).toBe(false);
    expect(prep.plan.args).not.toContain(AGY_BYPASS);
    // The model flag is still emitted in safe mode.
    expect(prep.plan.args.slice(0, 2)).toEqual(["--model", "gemini-3.7-flash-high"]);
  });

  it("a requested bypass on a provider with no native bypass flag surfaces a permissionNote, never a silent downgrade", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: (await registry.add({ name: "D1", path: "/w/D1", defaultProvider: "claude" })).id, taskGoal: "ship" }, { permissionMode: "bypass" });
    expect(prep.plan.bypassPermissions).toBe(false);
    expect(prep.permissionNote).toContain("claude");
  });
});

describe("permission + model reach the native CLI on fresh launch", () => {
  it("Antigravity fresh launch carries --model <id> + bypass before the prompt-only positional", async () => {
    const { deps, registry } = await buildDeps();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, modelAlias: "pro", taskGoal: "ship it" },
      {},
    );
    expect(prep.plan.args.slice(0, 3)).toEqual(["--model", "gemini-3.1-pro-high", AGY_BYPASS]);
    expect(prep.plan.args).toHaveLength(4);
    expect(prep.plan.args[3]).toContain("ship it");
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

describe("permission + model survive resume and handoff-receiving launches", () => {
  it("Antigravity resume carries --model (preserved), bypass, and --conversation <id>", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch(
      { projectKey: (await registry.add({ name: "A1", path: "/w/A1", defaultProvider: "antigravity" })).id, modelAlias: "high", taskGoal: "ship" },
      {},
    );
    await sessionManager.recordNativeSessionId(first.session!.sessionId, "antigravity", "conv-777");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, {});
    expect(resume.plan.args.slice(0, 5)).toEqual(["--model", "gemini-3.7-flash-high", AGY_BYPASS, "--conversation", "conv-777"]);
    expect(resume.plan.args[5]).toContain("ship");
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

  it("handoff-receiving launch inherits the target provider's bypass default", async () => {
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
    expect(handoff.plan.args).toContain(AGY_BYPASS);
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
