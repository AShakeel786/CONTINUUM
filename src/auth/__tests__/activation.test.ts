import { describe, expect, it } from "vitest";
import { envVarForProviderAuth, resolveProviderAuthEnv } from "../activation.js";
import { CredentialManager } from "../credential-manager.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { FakeBackend } from "./fake-backend.js";
import { InvalidCredentialError } from "../errors.js";

describe("envVarForProviderAuth", () => {
  it("returns the env var for api-key/bearer auth, undefined otherwise", () => {
    expect(envVarForProviderAuth(createProviderAdapter(claudeProfile))).toBe("ANTHROPIC_API_KEY");
    expect(envVarForProviderAuth(createProviderAdapter(deepseekProfile))).toBe("DEEPSEEK_API_KEY");
  });
});

describe("resolveProviderAuthEnv", () => {
  it("returns { envVar: value } from the store without mutating process.env", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    await mgr.setCredential("deepseek", "api-key", "sk-env-test");
    const result = await resolveProviderAuthEnv(createProviderAdapter(deepseekProfile), mgr);
    expect(result).toEqual({ DEEPSEEK_API_KEY: "sk-env-test" });
    // Never leaked into the live process env.
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("throws InvalidCredentialError for a cli-session/provider without credential-backed auth", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    // Claude's profile is api-key backed, so this path is the non-credential
    // branch: build a profile whose auth is cli-session.
    const adapter = createProviderAdapter({ ...claudeProfile, auth: { kind: "cli-session" as const } });
    await expect(resolveProviderAuthEnv(adapter, mgr)).rejects.toBeInstanceOf(InvalidCredentialError);
  });
});
