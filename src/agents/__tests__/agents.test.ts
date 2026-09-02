import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentManager } from "../agents.js";
import { AgentValidationError } from "../errors.js";
import { ConfigStore } from "../../config/store.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import { claudeAuthMetadata } from "../../auth/provider-auth/claude.js";
import { codexAuthMetadata } from "../../auth/provider-auth/codex.js";
import { loadUserManifests } from "../../providers/manifest-store.js";
import type { CredentialBackend } from "../../auth/types.js";
import type { CliAuthAdapter } from "../../auth/types.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "in-memory test backend";
  private readonly store = new Map<string, string>();
  readonly deleteLog: string[] = [];
  async isAvailable(): Promise<boolean> { return true; }
  async set(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async get(key: string): Promise<string | undefined> { return this.store.get(key); }
  async delete(key: string): Promise<void> { this.store.delete(key); this.deleteLog.push(key); }
  async list(): Promise<readonly string[]> { return [...this.store.keys()]; }
  peek(key: string): string | undefined { return this.store.get(key); }
}

interface FakeCliOptions {
  installed?: boolean;
  authenticated?: boolean;
  loginResult?: { completed: boolean; exitCode: number | null };
  logoutLog?: string[];
}

function fakeAdapter(providerId: string, capability: CliAuthAdapter["capability"], opts: FakeCliOptions): CliAuthAdapter {
  return {
    providerId,
    capability,
    async detectInstalled() { return opts.installed === false ? "not-installed" : "installed"; },
    async detectAuthenticated() { return opts.authenticated === false ? "not-authenticated" : "authenticated"; },
    async login() { return opts.loginResult ?? { completed: true, exitCode: 0 }; },
    async logout() { opts.logoutLog?.push(providerId); return { completed: true, exitCode: 0 }; },
  };
}

function makeCliManager(opts: FakeCliOptions = {}): CliAuthManager {
  const m = new CliAuthManager();
  m.register(fakeAdapter("claude", claudeAuthMetadata.cli as never, opts));
  m.register(fakeAdapter("codex", codexAuthMetadata.cli as never, opts));
  return m;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cont-agents-"));
}

describe("AgentManager — list", () => {
  it("lists bundled agents with source/configured/usable facts", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const manager = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({}),
      buildCliAuthManager: () => makeCliManager(),
    });
    const descriptors = await manager.listDescriptors();
    const ids = descriptors.map((d) => d.providerId).sort();
    expect(ids).toEqual([
      "antigravity",
      "cerebras-trial",
      "claude",
      "cloudflare-workers-ai-free",
      "codex",
      "deepseek",
      "gemini-free",
      "glm-5-2-free",
      "groq-free",
      "huggingface-free",
      "local-ornith15",
      "nvidia-free",
      "openrouter-free",
    ]);
    const claude = descriptors.find((d) => d.providerId === "claude")!;
    expect(claude.source).toBe("builtin");
    expect(claude.auth.cli).toBe(true);
    expect(claude.auth.api).toBe(true);
    expect(claude.configured).toBe(false);
    expect(claude.usable).toBe(true); // fake CLI reports installed + authenticated
    for (const id of ["gemini-free", "groq-free", "openrouter-free"]) {
      const provider = descriptors.find((d) => d.providerId === id)!;
      expect(provider.source).toBe("builtin");
      expect(provider.auth).toEqual({ api: true, cli: false, proxyUserKey: false });
      expect(provider.configured).toBe(false);
      expect(provider.usable).toBe(false);
    }
  });

  it("declares no promotional labels on any bundled agent (promo is dormant generic infra now)", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const manager = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({}),
      buildCliAuthManager: () => makeCliManager(),
    });
    const descriptors = await manager.listDescriptors();
    // No bundled provider carries a limited-time promo anymore — "FREE · limited
    // time" messaging was removed when the retired Ox Alpha identity was replaced
    // by GLM 5.2 Free, whose free status is standing, not promotional.
    for (const d of descriptors) {
      expect(d.promo).toBeUndefined();
    }
  });
});

describe("AgentManager — add", () => {
  it("adds an API agent (deepseek) in direct mode storing only the API key (no proxy key)", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const credentialManager = new CredentialManager(backend);
    const prompt = createScriptedPrompt({ secrets: ["sk-deepseek-key", "proxy-key-123"] });
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager,
      prompt,
      buildCliAuthManager: () => makeCliManager(),
    });

    const d = await mgr.add("deepseek");
    expect(d?.configured).toBe(true);
    expect(d?.configuredMethod).toBe("api");
    expect(d?.route).toBe("direct");
    expect(backend.peek("continuum:deepseek:api-key")).toBe("sk-deepseek-key");
    // Direct mode never collects the proxy user key.
    expect(backend.peek("continuum:deepseek:proxy-user-key")).toBeUndefined();
    const config = await configStore.load();
    expect(config.providers.some((p) => p.providerId === "deepseek" && p.method === "api")).toBe(true);
    expect(config.proxyRouting?.["deepseek"]).toBeUndefined();
  });

  it("adds an API agent (deepseek) in proxy mode storing both the key and the proxy key", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const credentialManager = new CredentialManager(backend);
    const prompt = createScriptedPrompt({ secrets: ["sk-deepseek-key", "proxy-key-123"] });
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager,
      prompt,
      buildCliAuthManager: () => makeCliManager(),
    });

    const d = await mgr.add("deepseek", undefined, "proxy");
    expect(d?.configured).toBe(true);
    expect(d?.route).toBe("proxy");
    expect(backend.peek("continuum:deepseek:api-key")).toBe("sk-deepseek-key");
    expect(backend.peek("continuum:deepseek:proxy-user-key")).toBe("proxy-key-123");
    const config = await configStore.load();
    expect(config.proxyRouting?.["deepseek"]).toBe("proxy");
  });

  it("adds a CLI agent (codex) without storing any credential", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({}),
      buildCliAuthManager: () => makeCliManager(),
    });

    const d = await mgr.add("codex");
    expect(d?.configured).toBe(true);
    expect(d?.configuredMethod).toBe("cli");
    const config = await configStore.load();
    expect(config.providers.some((p) => p.providerId === "codex" && p.method === "cli")).toBe(true);
    expect(JSON.stringify(config)).not.toContain("sk-");
  });

  it("refuses to persist config when CLI validation fails", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({}),
      buildCliAuthManager: () => makeCliManager({ authenticated: false }),
    });

    await expect(mgr.add("codex")).rejects.toThrow(AgentValidationError);
    const config = await configStore.load();
    expect(config.providers).toHaveLength(0);
  });
});

describe("AgentManager — addCustom + persistence/reload", () => {
  it("saves a manifest and records config; a fresh manager reloads it", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const prompt = createScriptedPrompt({ secrets: ["sk-gemini-key"] });
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt,
      buildCliAuthManager: () => makeCliManager(),
    });

    const added = await mgr.addCustom({
      id: "gemini",
      displayName: "Gemini",
      protocol: "openai-compatible",
      baseUrl: "https://generativelanguage.googleapis.com",
      auth: "api-key",
      envVar: "GEMINI_API_KEY",
      model: "gemini-2.5-pro",
    });
    expect(added.configured).toBe(true);
    expect(added.source).toBe("user");

    // Manifest persisted to disk.
    const { manifests } = await loadUserManifests(dataDir);
    expect(manifests.map((m) => m.id)).toEqual(["gemini"]);

    // A brand-new manager over the same dataDir + backend sees it immediately.
    const reloaded = new AgentManager({
      dataDir,
      configStore: new ConfigStore(dataDir),
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({}),
      buildCliAuthManager: () => makeCliManager(),
    });
    const descriptors = await reloaded.listDescriptors();
    const gemini = descriptors.find((d) => d.providerId === "gemini")!;
    expect(gemini).toBeDefined();
    expect(gemini.configured).toBe(true);
    expect(gemini.usable).toBe(true);
  });

  it("rejects a reserved bundled id", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const manager = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({}),
      buildCliAuthManager: () => makeCliManager(),
    });
    await expect(
      manager.addCustom({
        id: "claude",
        displayName: "Claude",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        auth: "api-key",
        envVar: "ANTHROPIC_API_KEY",
        model: "x",
      }),
    ).rejects.toThrow(AgentValidationError);
  });
});

describe("AgentManager — remove", () => {
  it("removes a custom agent's manifest + config + credential", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({ secrets: ["sk-gemini-key"] }),
      buildCliAuthManager: () => makeCliManager(),
    });
    await mgr.addCustom({
      id: "gemini",
      displayName: "Gemini",
      protocol: "openai-compatible",
      baseUrl: "https://example.com",
      auth: "api-key",
      envVar: "GEMINI_API_KEY",
      model: "gemini",
    });

    const result = await mgr.remove("gemini");
    expect(result.removedConfigEntry).toBe(true);
    expect(result.removedManifest).toBe(true);
    expect(backend.peek("continuum:gemini:api-key")).toBeUndefined();
    const { manifests } = await loadUserManifests(dataDir);
    expect(manifests).toHaveLength(0);
  });

  it("removing a built-in agent only unregisters it (never touches the CLI)", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const logoutLog: string[] = [];
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({}),
      buildCliAuthManager: () => makeCliManager({ logoutLog }),
    });
    await mgr.add("codex");

    const result = await mgr.remove("codex");
    expect(result.removedConfigEntry).toBe(true);
    expect(result.removedManifest).toBe(false);
    expect(logoutLog).toEqual([]); // CLI login was never touched

    const descriptors = await mgr.listDescriptors();
    expect(descriptors.find((d) => d.providerId === "codex")?.configured).toBe(false);
    const config = await configStore.load();
    expect(config.providers).toHaveLength(0);
  });
});

describe("AgentManager — configure", () => {
  it("re-runs auth and replaces the config entry", async () => {
    const dataDir = tmp();
    const backend = new FakeBackend();
    const configStore = new ConfigStore(dataDir);
    const mgr = new AgentManager({
      dataDir,
      configStore,
      credentialManager: new CredentialManager(backend),
      prompt: createScriptedPrompt({ secrets: ["sk-gemini-key", "sk-gemini-key-2"] }),
      buildCliAuthManager: () => makeCliManager(),
    });
    await mgr.addCustom({
      id: "gemini",
      displayName: "Gemini",
      protocol: "openai-compatible",
      baseUrl: "https://example.com",
      auth: "api-key",
      envVar: "GEMINI_API_KEY",
      model: "gemini",
    });

    const configured = await mgr.configure("gemini");
    expect(configured?.configuredMethod).toBe("api");
    const config = await configStore.load();
    expect(config.providers.filter((p) => p.providerId === "gemini")).toHaveLength(1);
  });
});
