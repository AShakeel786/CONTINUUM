import { describe, expect, it } from "vitest";
import { Doctor } from "../doctor.js";
import { CredentialManager } from "../credential-manager.js";
import { CliAuthManager } from "../cli-auth-manager.js";
import { FakeBackend } from "./fake-backend.js";
import { createDefaultProviderAuthMetadata } from "../provider-auth/index.js";
import { emptyConfig, type ContinuumConfig } from "../../config/types.js";

function configWithProvider(providerId: string, method: "api" | "cli", credentialKey?: string): ContinuumConfig {
  return {
    ...emptyConfig("2026-08-15T00:00:00Z"),
    providers: [{ providerId, method, ...(credentialKey ? { credentialKey } : {}), configuredAt: "2026-08-15T00:00:00Z" }],
  };
}

describe("Doctor", () => {
  it("reports healthy with no providers configured", async () => {
    const doctor = new Doctor({
      credentialManager: new CredentialManager(new FakeBackend()),
      cliAuthManager: new CliAuthManager(),
      providerMetadata: createDefaultProviderAuthMetadata(),
    });
    const report = await doctor.diagnose(emptyConfig("2026-08-15T00:00:00Z"));
    expect(report.overall).toBe("healthy");
    expect(report.findings).toEqual([]);
    expect(report.backendId).toBe("fake");
  });

  it("reports unhealthy when a configured API credential is missing", async () => {
    const doctor = new Doctor({
      credentialManager: new CredentialManager(new FakeBackend()),
      cliAuthManager: new CliAuthManager(),
      providerMetadata: createDefaultProviderAuthMetadata(),
    });
    const report = await doctor.diagnose(configWithProvider("deepseek", "api", "credential://deepseek/api-key"));
    expect(report.overall).toBe("unhealthy");
    expect(report.findings[0]!.healthy).toBe(false);
  });

  it("reports healthy when the stored API credential resolves", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    await mgr.setCredential("deepseek", "api-key", "sk-ok");
    const doctor = new Doctor({
      credentialManager: mgr,
      cliAuthManager: new CliAuthManager(),
      providerMetadata: createDefaultProviderAuthMetadata(),
    });
    const report = await doctor.diagnose(configWithProvider("deepseek", "api", "credential://deepseek/api-key"));
    expect(report.overall).toBe("healthy");
    expect(report.findings[0]!.healthy).toBe(true);
    expect(JSON.stringify(report)).not.toContain("sk-ok");
  });
});
