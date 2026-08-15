import { describe, expect, it } from "vitest";
import { ProviderSetup } from "../provider-setup.js";
import { CredentialManager } from "../credential-manager.js";
import { CliAuthManager } from "../cli-auth-manager.js";
import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import { createScriptedPrompt } from "../prompt.js";
import { FakeBackend } from "./fake-backend.js";
import { claudeAuthMetadata } from "../provider-auth/claude.js";
import { deepseekAuthMetadata } from "../provider-auth/deepseek.js";
import { emptyConfig } from "../../config/types.js";
import type { CliAuthAdapter } from "../types.js";

/**
 * A CLI adapter that never spawns a real binary — login returns a
 * scripted result immediately. Critical for tests: the real `claude`
 * credential login must never be invoked (it spawns an interactive
 * OAuth/browser flow and would block or disrupt the running session).
 */
function fakeCliManager(loginResult: { completed: boolean; exitCode: number | null } = { completed: true, exitCode: 0 }): CliAuthManager {
  const adapter: CliAuthAdapter = {
    providerId: "claude",
    capability: claudeAuthMetadata.cli as never,
    async detectInstalled() {
      return "installed";
    },
    async detectAuthenticated() {
      return "authenticated";
    },
    async login() {
      return loginResult;
    },
    async logout() {
      return { completed: true, exitCode: 0 };
    },
  };
  const m = new CliAuthManager();
  m.register(adapter);
  return m;
}

describe("ProviderSetup (API)", () => {
  it("stores a masked API key and returns its reference", async () => {
    const backend = new FakeBackend();
    const mgr = new CredentialManager(backend);
    const prompt = createScriptedPrompt({ secrets: ["sk-deepseek-key-123"] });
    const setup = new ProviderSetup({ credentialManager: mgr, cliAuthManager: fakeCliManager(), prompt });
    const result = await setup.setup(deepseekAuthMetadata, "api");
    expect(result.method).toBe("api");
    expect(result.credentialUri).toBe("credential://deepseek/api-key");
    expect(backend.peek("continuum:deepseek:api-key")).toBe("sk-deepseek-key-123");
  });

  it("refuses to store an empty key (returns no uri)", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    const prompt = createScriptedPrompt({ secrets: ["   "] });
    const setup = new ProviderSetup({ credentialManager: mgr, cliAuthManager: fakeCliManager(), prompt });
    const result = await setup.setup(deepseekAuthMetadata, "api");
    expect(result.credentialUri).toBeUndefined();
  });
});

describe("ProviderSetup (CLI)", () => {
  it("runs login and returns method cli with no credential uri", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    const setup = new ProviderSetup({ credentialManager: mgr, cliAuthManager: fakeCliManager(), prompt: createScriptedPrompt({}) });
    const result = await setup.setup(claudeAuthMetadata, "cli");
    expect(result.method).toBe("cli");
    expect(result.credentialUri).toBeUndefined();
  });
});

describe("ProviderSetup (config entries)", () => {
  it("applyConfigEntry records a reference (never a value) and replaces existing", async () => {
    const setup = new ProviderSetup({ credentialManager: new CredentialManager(new FakeBackend()), cliAuthManager: fakeCliManager(), prompt: createScriptedPrompt({}) });
    let config = emptyConfig("2026-08-15T00:00:00Z");
    config = setup.applyConfigEntry(config, "deepseek", "api", "credential://deepseek/api-key");
    const entry = config.providers.find((p) => p.providerId === "deepseek")!;
    expect(entry.method).toBe("api");
    expect(entry.credentialKey).toBe("credential://deepseek/api-key");
    expect(JSON.stringify(config)).not.toContain("sk-");
  });

  it("removeConfigEntry drops the entry", async () => {
    const setup = new ProviderSetup({ credentialManager: new CredentialManager(new FakeBackend()), cliAuthManager: fakeCliManager(), prompt: createScriptedPrompt({}) });
    let config = emptyConfig("2026-08-15T00:00:00Z");
    config = setup.applyConfigEntry(config, "deepseek", "api", "credential://deepseek/api-key");
    const removed = setup.removeConfigEntry(config, "deepseek");
    expect(removed.providers).toEqual([]);
  });
});
