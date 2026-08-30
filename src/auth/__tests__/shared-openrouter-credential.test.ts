import { describe, expect, it } from "vitest";
import { createProviderAdapter } from "../../providers/adapter.js";
import { UnknownModelAliasError } from "../../providers/errors.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { openRouterFreeManifest, glm52FreeManifest } from "../../providers/presets.js";
import { emptyConfig } from "../../config/types.js";
import { evaluateProvider } from "../../launcher/usability.js";
import { CliAuthManager } from "../cli-auth-manager.js";
import { CredentialManager } from "../credential-manager.js";
import { Doctor } from "../doctor.js";
import { createDefaultProviderAuthMetadata } from "../provider-auth/index.js";
import { ProviderSetup } from "../provider-setup.js";
import { createScriptedPrompt } from "../prompt.js";
import { FakeBackend } from "./fake-backend.js";

const STORED_KEY = "opaque-openrouter-credential-value";

/** A config persisted by a pre-rename install: the legacy ox-alpha id + URI. */
function configWithLegacyOx() {
  return {
    ...emptyConfig("2026-08-26T00:00:00Z"),
    providers: [{
      providerId: "ox-alpha",
      method: "api" as const,
      credentialKey: "credential://ox-alpha/api-key",
      configuredAt: "2026-08-26T00:00:00Z",
    }],
  };
}

describe("shared OpenRouter credential (GLM 5.2 Free + OpenRouter Free)", () => {
  it("uses one canonical backend entry for both GLM 5.2 Free and OpenRouter Free", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("glm-5-2-free", "api-key", STORED_KEY);
    const metadata = createDefaultProviderAuthMetadata();
    const deps = { cliAuthManager: new CliAuthManager(), credentialManager: credentials, findExecutable: () => undefined };

    const glm = await evaluateProvider(
      createProviderAdapter(manifestToProfile(glm52FreeManifest)),
      metadata.get("glm-5-2-free")!,
      deps,
    );
    const free = await evaluateProvider(
      createProviderAdapter(manifestToProfile(openRouterFreeManifest)),
      metadata.get("openrouter-free")!,
      deps,
    );

    expect(glm.usable).toBe(true);
    expect(free.usable).toBe(true);
    expect(await backend.list()).toEqual(["continuum:glm-5-2-free:api-key"]);
    expect(await credentials.hasCredential("openrouter-free", "api-key")).toBe(false);
  });

  it("a key stored under the legacy ox-alpha id still satisfies GLM 5.2 Free via the id alias", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("ox-alpha", "api-key", STORED_KEY);
    const metadata = createDefaultProviderAuthMetadata();
    const deps = { cliAuthManager: new CliAuthManager(), credentialManager: credentials, findExecutable: () => undefined };

    const glm = await evaluateProvider(
      createProviderAdapter(manifestToProfile(glm52FreeManifest)),
      metadata.get("glm-5-2-free")!,
      deps,
    );
    const free = await evaluateProvider(
      createProviderAdapter(manifestToProfile(openRouterFreeManifest)),
      metadata.get("openrouter-free")!,
      deps,
    );

    expect(glm.usable).toBe(true);
    expect(free.usable).toBe(true);
    // No key was rewritten: the legacy entry alone satisfies both consumers.
    expect(await backend.list()).toEqual(["continuum:ox-alpha:api-key"]);
  });

  it("openrouter-free setup reuses the existing canonical key without prompting or writing", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("glm-5-2-free", "api-key", STORED_KEY);
    const metadata = createDefaultProviderAuthMetadata().get("openrouter-free")!;
    const setup = new ProviderSetup({
      credentialManager: credentials,
      cliAuthManager: new CliAuthManager(),
      prompt: createScriptedPrompt({}),
    });

    const result = await setup.setupApi(metadata);
    expect(result.credentialUri).toBe("credential://glm-5-2-free/api-key");
    // The only write was the seeding above — setup added nothing.
    expect(backend.setLog).toEqual(["continuum:glm-5-2-free:api-key"]);
    expect(await backend.list()).toEqual(["continuum:glm-5-2-free:api-key"]);

    const config = setup.applyConfigEntry(emptyConfig("2026-08-26T00:00:00Z"), "openrouter-free", "api", result.credentialUri);
    expect(config.providers.map((entry) => entry.credentialKey)).toEqual([
      "credential://glm-5-2-free/api-key",
    ]);
    expect(JSON.stringify(config)).not.toContain(STORED_KEY);
  });

  it("first-time openrouter-free setup writes only the canonical OpenRouter entry", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    const metadata = createDefaultProviderAuthMetadata().get("openrouter-free")!;
    const setup = new ProviderSetup({
      credentialManager: credentials,
      cliAuthManager: new CliAuthManager(),
      prompt: createScriptedPrompt({ secrets: [STORED_KEY] }),
    });

    const result = await setup.setupApi(metadata);
    expect(result.credentialUri).toBe("credential://glm-5-2-free/api-key");
    expect(await backend.list()).toEqual(["continuum:glm-5-2-free:api-key"]);
    expect(backend.setLog).toEqual(["continuum:glm-5-2-free:api-key"]);
    expect(await credentials.hasCredential("openrouter-free", "api-key")).toBe(false);
  });

  it("deleting the canonical entry removes the legacy alias too, making both providers unavailable", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("glm-5-2-free", "api-key", STORED_KEY);
    // A pre-rename install also left the legacy key behind.
    await credentials.setCredential("ox-alpha", "api-key", STORED_KEY);
    await credentials.deleteCredential("glm-5-2-free", "api-key");
    const metadata = createDefaultProviderAuthMetadata();
    const deps = { cliAuthManager: new CliAuthManager(), credentialManager: credentials, findExecutable: () => undefined };

    for (const [id, manifest] of [["glm-5-2-free", glm52FreeManifest], ["openrouter-free", openRouterFreeManifest]] as const) {
      const result = await evaluateProvider(createProviderAdapter(manifestToProfile(manifest)), metadata.get(id)!, deps);
      expect(result.usable).toBe(false);
      expect(result.reason).toContain("Configure OpenRouter once");
    }
    expect(await backend.list()).toEqual([]);
  });

  it("doctor resolves a legacy ox-alpha config entry via its current identity", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("ox-alpha", "api-key", STORED_KEY);
    const doctor = new Doctor({
      credentialManager: credentials,
      cliAuthManager: new CliAuthManager(),
      providerMetadata: createDefaultProviderAuthMetadata(),
      resolveProviderId: (id) => (id === "ox-alpha" ? "glm-5-2-free" : id),
    });

    const report = await doctor.diagnose(configWithLegacyOx());
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "ox-alpha", healthy: true }),
      expect.objectContaining({ providerId: "openrouter-free", method: "shared-api", healthy: true }),
    ]));
    expect(JSON.stringify(report)).not.toContain(STORED_KEY);
  });

  it("keeps OpenRouter Free model resolution restricted to openrouter/free", () => {
    const adapter = createProviderAdapter(manifestToProfile(openRouterFreeManifest));
    expect(adapter.resolveModel()).toBe("openrouter/free");
    expect(() => adapter.resolveModel("openai/gpt-5")).toThrow(UnknownModelAliasError);
  });
});
