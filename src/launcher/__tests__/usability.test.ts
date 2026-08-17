import { describe, expect, it } from "vitest";
import { evaluateProvider } from "../usability.js";
import { manifestToAuthMetadata, manifestToProfile, type ProviderManifest } from "../../providers/manifest.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeManifest, codexManifest, deepseekManifest } from "../../providers/presets.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { claudeAuthMetadata } from "../../auth/provider-auth/claude.js";
import { codexAuthMetadata } from "../../auth/provider-auth/codex.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "in-memory test backend";
  private readonly store = new Map<string, string>();
  async isAvailable(): Promise<boolean> { return true; }
  async set(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async get(key: string): Promise<string | undefined> { return this.store.get(key); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async list(): Promise<readonly string[]> { return [...this.store.keys()]; }
  seed(key: string, value: string): void { this.store.set(key, value); }
}

interface FakeCliOpts {
  installed?: boolean;
  authenticated?: boolean;
}
function fakeAdapter(providerId: string, capability: CliAuthAdapter["capability"], opts: FakeCliOpts): CliAuthAdapter {
  return {
    providerId,
    capability,
    async detectInstalled() { return opts.installed === false ? "not-installed" : "installed"; },
    async detectAuthenticated() { return opts.authenticated === false ? "not-authenticated" : "authenticated"; },
    async login() { return { completed: true, exitCode: 0 }; },
    async logout() { return { completed: true, exitCode: 0 }; },
  };
}
function makeCliManager(opts: FakeCliOpts = {}): CliAuthManager {
  const m = new CliAuthManager();
  m.register(fakeAdapter("claude", claudeAuthMetadata.cli as never, opts));
  m.register(fakeAdapter("codex", codexAuthMetadata.cli as never, opts));
  return m;
}

function adapterFor(manifest: ProviderManifest) {
  return createProviderAdapter(manifestToProfile(manifest));
}

const apiOnlyManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "gemini",
  displayName: "Gemini",
  protocol: "openai-compatible",
  baseUrl: "https://generativelanguage.googleapis.com",
  auth: { kind: "api-key", envVar: "GEMINI_API_KEY" },
  models: { default: "gemini-2.5-pro" },
};

const cliSessionOnlyManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "wizard",
  displayName: "Wizard",
  protocol: "openai-compatible",
  baseUrl: "https://example.com",
  auth: { kind: "cli-session" },
  models: { default: "wizard-1" },
};

describe("evaluateProvider — real launchable providers", () => {
  it("Claude is CLI-launchable when installed + authenticated", async () => {
    const metadata = manifestToAuthMetadata(claudeManifest);
    const e = await evaluateProvider(adapterFor(claudeManifest), metadata, {
      cliAuthManager: makeCliManager(),
      credentialManager: new CredentialManager(new FakeBackend()),
    });
    expect(e.usable).toBe(true);
    expect(e.launchKind).toBe("cli");
    expect(e.cliInstalled).toBe(true);
    expect(e.cliAuthenticated).toBe(true);
  });

  it("Codex is CLI-launchable when installed + authenticated", async () => {
    const metadata = manifestToAuthMetadata(codexManifest);
    const e = await evaluateProvider(adapterFor(codexManifest), metadata, {
      cliAuthManager: makeCliManager(),
      credentialManager: new CredentialManager(new FakeBackend()),
    });
    expect(e.usable).toBe(true);
    expect(e.launchKind).toBe("cli");
  });

  it("DeepSeek is CLI-launchable when `claude` is present and both keys are stored", async () => {
    const backend = new FakeBackend();
    backend.seed("continuum:deepseek:api-key", "sk-deepseek");
    backend.seed("continuum:deepseek:proxy-user-key", "proxy");
    const metadata = manifestToAuthMetadata(deepseekManifest);
    const e = await evaluateProvider(adapterFor(deepseekManifest), metadata, {
      cliAuthManager: makeCliManager(),
      credentialManager: new CredentialManager(backend),
      findExecutable: (exe) => (exe === "claude" ? "/usr/local/bin/claude" : undefined),
    });
    expect(e.usable).toBe(true);
    expect(e.launchKind).toBe("cli");
  });

  it("DeepSeek is not launchable when its CLI executable is missing", async () => {
    const backend = new FakeBackend();
    backend.seed("continuum:deepseek:api-key", "sk-deepseek");
    backend.seed("continuum:deepseek:proxy-user-key", "proxy");
    const metadata = manifestToAuthMetadata(deepseekManifest);
    const e = await evaluateProvider(adapterFor(deepseekManifest), metadata, {
      cliAuthManager: makeCliManager(),
      credentialManager: new CredentialManager(backend),
      findExecutable: () => undefined,
    });
    expect(e.usable).toBe(false);
    expect(e.reason).toContain("CLI not installed");
  });
});

describe("evaluateProvider — API-only custom providers", () => {
  it("is direct-API launchable when a key is stored (credentials never alone: runtime is checked)", async () => {
    const backend = new FakeBackend();
    backend.seed("continuum:gemini:api-key", "sk-gemini");
    const metadata = manifestToAuthMetadata(apiOnlyManifest);
    const e = await evaluateProvider(adapterFor(apiOnlyManifest), metadata, {
      cliAuthManager: makeCliManager(),
      credentialManager: new CredentialManager(backend),
    });
    expect(e.usable).toBe(true);
    expect(e.launchKind).toBe("direct-api");
  });

  it("is not launchable without a stored key", async () => {
    const metadata = manifestToAuthMetadata(apiOnlyManifest);
    const e = await evaluateProvider(adapterFor(apiOnlyManifest), metadata, {
      cliAuthManager: makeCliManager(),
      credentialManager: new CredentialManager(new FakeBackend()),
    });
    expect(e.usable).toBe(false);
    expect(e.reason).toContain("no stored API key");
  });

  it("a cli-session provider with no CLI is not direct-API launchable (no compatible runtime)", async () => {
    const metadata = manifestToAuthMetadata(cliSessionOnlyManifest);
    const e = await evaluateProvider(adapterFor(cliSessionOnlyManifest), metadata, {
      cliAuthManager: makeCliManager(),
      credentialManager: new CredentialManager(new FakeBackend()),
    });
    expect(e.usable).toBe(false);
    expect(e.launchKind).toBe("none");
    expect(e.reason).toContain("no compatible direct-API runtime");
  });
});
