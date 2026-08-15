import { describe, expect, it } from "vitest";
import { CredentialManager, credentialKeyFor, credentialUriFor, parseCredentialUri } from "../credential-manager.js";
import { CredentialNotFoundError } from "../errors.js";
import { FakeBackend } from "./fake-backend.js";

describe("CredentialManager", () => {
  it("stores a value and returns a credential:// reference, never the value", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    const uri = await mgr.setCredential("deepseek", "api-key", "sk-real-secret");
    expect(uri).toBe("credential://deepseek/api-key");
    expect(uri).not.toContain("sk-real-secret");
  });

  it("round-trips get/has/delete by provider+name", async () => {
    const backend = new FakeBackend();
    const mgr = new CredentialManager(backend);
    await mgr.setCredential("deepseek", "api-key", "sk-abc");
    expect(await mgr.hasCredential("deepseek", "api-key")).toBe(true);
    expect(await mgr.getCredential("deepseek", "api-key")).toBe("sk-abc");
    await mgr.deleteCredential("deepseek", "api-key");
    expect(await mgr.hasCredential("deepseek", "api-key")).toBe(false);
  });

  it("throws CredentialNotFoundError (never a bare value) when missing", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    await expect(mgr.getCredential("deepseek", "api-key")).rejects.toBeInstanceOf(CredentialNotFoundError);
  });

  it("lists provider credential names only, never values", async () => {
    const mgr = new CredentialManager(new FakeBackend());
    await mgr.setCredential("deepseek", "api-key", "sk-secret");
    await mgr.setCredential("claude", "api-key", "other-secret");
    const names = await mgr.listProviderCredentialNames("deepseek");
    expect(names).toEqual(["api-key"]);
    expect(names.join()).not.toContain("sk-secret");
  });
});

describe("reference helpers", () => {
  it("builds namespaced keys and parses uris", () => {
    expect(credentialKeyFor("deepseek", "api-key")).toBe("continuum:deepseek:api-key");
    expect(credentialUriFor("deepseek", "api-key")).toBe("credential://deepseek/api-key");
    expect(parseCredentialUri("credential://deepseek/api-key")).toEqual({ providerId: "deepseek", name: "api-key" });
    expect(parseCredentialUri("not-a-uri")).toBeUndefined();
  });
});
