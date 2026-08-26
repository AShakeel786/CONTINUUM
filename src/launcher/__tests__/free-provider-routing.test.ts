import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { CredentialBackend } from "../../auth/types.js";
import { createDefaultProviderRegistry } from "../../providers/index.js";
import { DEFAULT_PROVIDER_PREFERENCE_CHAIN } from "../../providers/presets.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { Launcher } from "../launcher.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test backend";
  private readonly values = new Map<string, string>();
  async isAvailable() { return true; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async get(key: string) { return this.values.get(key); }
  async delete(key: string) { this.values.delete(key); }
  async list() { return [...this.values.keys()]; }
}

async function launcherWithCredentials(providerIds: readonly string[]) {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-free-route-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-free-route-sess-"));
  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  const authMetadata = createDefaultProviderAuthMetadata();
  for (const providerId of providerIds) {
    const api = authMetadata.get(providerId)?.api;
    if (!api?.supported) throw new Error(`test provider ${providerId} has no API auth`);
    await credentialManager.setCredential(api.credentialRef.providerId, api.credentialRef.name, "fixture-token");
  }
  const cliAuthManager = new CliAuthManager();
  const launcher = new Launcher({
    projects: new ProjectRegistry(new ProjectRegistryStore(dataDir)),
    providers: createDefaultProviderRegistry(),
    credentialManager,
    cliAuthManager,
    authVerifier: new AuthVerifier({ credentialManager, cliAuthManager }),
    authMetadata,
    sessionManager: new SessionManager(new FileSessionStore(sessionDir)),
    prompt: createScriptedPrompt({}),
    sessionBaseDir: sessionDir,
    findExecutable: () => undefined,
  });
  return { launcher, cwd: dataDir };
}

async function prepare(providerIds: readonly string[]) {
  const { launcher, cwd } = await launcherWithCredentials(providerIds);
  return launcher.prepareLaunch(
    { mode: "current-directory", cwd, taskGoal: "ping" },
    { permissionMode: "safe" },
  );
}

describe("default free API provider routing", () => {
  it("selects Gemini first when the complete free pool is configured", async () => {
    const prep = await prepare(["gemini-free", "groq-free", "openrouter-free"]);
    expect(prep.providerRef.providerId).toBe("gemini-free");
    expect(prep.runtimeKind).toBe("api");
    expect(prep.autoRoute).toEqual({ chain: DEFAULT_PROVIDER_PREFERENCE_CHAIN, index: 0 });
  });

  it("skips missing Gemini credentials and selects Groq", async () => {
    const prep = await prepare(["groq-free", "openrouter-free"]);
    expect(prep.providerRef.providerId).toBe("groq-free");
    expect(prep.autoRoute).toEqual({ chain: DEFAULT_PROVIDER_PREFERENCE_CHAIN, index: 1 });
  });

  it("skips missing Gemini and Groq credentials and selects OpenRouter Free", async () => {
    const prep = await prepare(["openrouter-free"]);
    expect(prep.providerRef.providerId).toBe("openrouter-free");
    expect(prep.autoRoute).toEqual({ chain: DEFAULT_PROVIDER_PREFERENCE_CHAIN, index: 2 });
  });
});
