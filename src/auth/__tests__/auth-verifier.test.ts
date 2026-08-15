import { describe, expect, it } from "vitest";
import { AuthVerifier } from "../auth-verifier.js";
import { CredentialManager } from "../credential-manager.js";
import { CliAuthManager } from "../cli-auth-manager.js";
import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import { FakeBackend } from "./fake-backend.js";
import { claudeAuthMetadata } from "../provider-auth/claude.js";
import { deepseekAuthMetadata } from "../provider-auth/deepseek.js";
import type { CliAuthCapability } from "../types.js";

function emptyCliManager(): CliAuthManager {
  const m = new CliAuthManager();
  return m;
}

describe("AuthVerifier (API)", () => {
  it("reports missing when no credential stored", async () => {
    const v = new AuthVerifier({ credentialManager: new CredentialManager(new FakeBackend()), cliAuthManager: emptyCliManager() });
    const r = await v.verifyApi(deepseekAuthMetadata);
    expect(r.outcome).toBe("missing");
  });

  it("reports ok when a non-empty credential is present", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    await mgr.setCredential("deepseek", "api-key", "sk-abc");
    const v = new AuthVerifier({ credentialManager: mgr, cliAuthManager: emptyCliManager() });
    const r = await v.verifyApi(deepseekAuthMetadata);
    expect(r.outcome).toBe("ok");
  });

  it("never includes the secret value in the detail", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    await mgr.setCredential("deepseek", "api-key", "sk-super-secret-xyz");
    const v = new AuthVerifier({ credentialManager: mgr, cliAuthManager: emptyCliManager() });
    const r = await v.verifyApi(deepseekAuthMetadata);
    expect(r.detail).not.toContain("sk-super-secret-xyz");
  });
});

describe("AuthVerifier (CLI)", () => {
  it("reports not-installed when the CLI is absent", async () => {
    const m = new CliAuthManager();
    m.register(createCliAuthAdapter("claude", {
      supported: true,
      executable: "definitely-not-a-real-cli-xyz",
      versionArgs: ["--version"],
      loginArgs: ["login"],
      statusArgs: ["status"],
    } as CliAuthCapability));
    const v = new AuthVerifier({ credentialManager: new CredentialManager(new FakeBackend()), cliAuthManager: m });
    const r = await v.verifyCli(claudeAuthMetadata);
    expect(r.outcome).toBe("not-installed");
  });
});
