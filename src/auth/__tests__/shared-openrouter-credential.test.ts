import { describe, expect, it } from "vitest";
import { createProviderAdapter } from "../../providers/adapter.js";
import { UnknownModelAliasError } from "../../providers/errors.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { openRouterFreeManifest, oxAlphaManifest } from "../../providers/presets.js";
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

function configWithOx() {
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

describe("shared OpenRouter credential", () => {
  it("uses one canonical backend entry for both Ox Alpha and OpenRouter Free", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("ox-alpha", "api-key", STORED_KEY);
    const metadata = createDefaultProviderAuthMetadata();
    const deps = { cliAuthManager: new CliAuthManager(), credentialManager: credentials, findExecutable: () => undefined };

    const ox = await evaluateProvider(
      createProviderAdapter(manifestToProfile(oxAlphaManifest)),
      metadata.get("ox-alpha")!,
      deps,
    );
    const free = await evaluateProvider(
      createProviderAdapter(manifestToProfile(openRouterFreeManifest)),
      metadata.get("openrouter-free")!,
      deps,
    );

    expect(ox.usable).toBe(true);
    expect(free.usable).toBe(true);
    expect(await backend.list()).toEqual(["continuum:ox-alpha:api-key"]);
    expect(await credentials.hasCredential("openrouter-free", "api-key")).toBe(false);
  });

  it("openrouter-free setup reuses the existing URI without prompting or writing", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("ox-alpha", "api-key", STORED_KEY);
    const metadata = createDefaultProviderAuthMetadata().get("openrouter-free")!;
    const setup = new ProviderSetup({
      credentialManager: credentials,
      cliAuthManager: new CliAuthManager(),
      prompt: createScriptedPrompt({}),
    });

    const result = await setup.setupApi(metadata);
    expect(result.credentialUri).toBe("credential://ox-alpha/api-key");
    expect(backend.setLog).toEqual(["continuum:ox-alpha:api-key"]);
    expect(await backend.list()).toEqual(["continuum:ox-alpha:api-key"]);

    const config = setup.applyConfigEntry(configWithOx(), "openrouter-free", "api", result.credentialUri);
    expect(config.providers.map((entry) => entry.credentialKey)).toEqual([
      "credential://ox-alpha/api-key",
      "credential://ox-alpha/api-key",
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
    expect(result.credentialUri).toBe("credential://ox-alpha/api-key");
    expect(await backend.list()).toEqual(["continuum:ox-alpha:api-key"]);
    expect(backend.setLog).toEqual(["continuum:ox-alpha:api-key"]);
    expect(await credentials.hasCredential("openrouter-free", "api-key")).toBe(false);
  });

  it("deleting the canonical entry makes both providers unavailable with one setup instruction", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("ox-alpha", "api-key", STORED_KEY);
    await credentials.deleteCredential("ox-alpha", "api-key");
    const metadata = createDefaultProviderAuthMetadata();
    const deps = { cliAuthManager: new CliAuthManager(), credentialManager: credentials, findExecutable: () => undefined };

    for (const [id, manifest] of [["ox-alpha", oxAlphaManifest], ["openrouter-free", openRouterFreeManifest]] as const) {
      const result = await evaluateProvider(createProviderAdapter(manifestToProfile(manifest)), metadata.get(id)!, deps);
      expect(result.usable).toBe(false);
      expect(result.reason).toContain("Configure OpenRouter once");
    }
    expect(await backend.list()).toEqual([]);
  });

  it("doctor reports OpenRouter Free healthy from the shared Ox credential", async () => {
    const backend = new FakeBackend();
    const credentials = new CredentialManager(backend);
    await credentials.setCredential("ox-alpha", "api-key", STORED_KEY);
    const doctor = new Doctor({
      credentialManager: credentials,
      cliAuthManager: new CliAuthManager(),
      providerMetadata: createDefaultProviderAuthMetadata(),
    });

    const report = await doctor.diagnose(configWithOx());
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
