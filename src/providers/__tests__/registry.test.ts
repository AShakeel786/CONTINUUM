import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../registry.js";
import { createProviderAdapter } from "../adapter.js";
import { claudeProfile } from "../profiles/claude.js";
import { deepseekProfile } from "../profiles/deepseek.js";
import { createDefaultProviderRegistry } from "../index.js";
import { DuplicateProviderError, UnknownProviderError } from "../errors.js";

describe("ProviderRegistry", () => {
  it("registers and looks up a provider by id", () => {
    const registry = new ProviderRegistry();
    registry.register(createProviderAdapter(claudeProfile));
    const adapter = registry.get("claude");
    expect(adapter.profile.id).toBe("claude");
  });

  it("throws UnknownProviderError for an unregistered id, listing what IS registered", () => {
    const registry = new ProviderRegistry();
    registry.register(createProviderAdapter(claudeProfile));
    expect(() => registry.get("gemini")).toThrowError(UnknownProviderError);
    try {
      registry.get("gemini");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownProviderError);
      const e = err as UnknownProviderError;
      expect(e.providerId).toBe("gemini");
      expect(e.message).toContain("claude");
    }
  });

  it("has() reports registration without throwing", () => {
    const registry = new ProviderRegistry();
    expect(registry.has("claude")).toBe(false);
    registry.register(createProviderAdapter(claudeProfile));
    expect(registry.has("claude")).toBe(true);
  });

  it("rejects a duplicate registration for the same id", () => {
    const registry = new ProviderRegistry();
    registry.register(createProviderAdapter(claudeProfile));
    expect(() => registry.register(createProviderAdapter(claudeProfile))).toThrowError(
      DuplicateProviderError,
    );
  });

  it("listIds / listProfiles reflect every registered provider", () => {
    const registry = new ProviderRegistry();
    registry.register(createProviderAdapter(claudeProfile));
    registry.register(createProviderAdapter(deepseekProfile));
    expect([...registry.listIds()].sort()).toEqual(["claude", "deepseek"]);
    expect(registry.listProfiles().map((p) => p.id).sort()).toEqual(["claude", "deepseek"]);
  });

  it("getCapabilities is a lookup+capability shortcut, not a separate code path", () => {
    const registry = new ProviderRegistry();
    registry.register(createProviderAdapter(claudeProfile));
    expect(registry.getCapabilities("claude")).toEqual(claudeProfile.capabilities);
    expect(() => registry.getCapabilities("unknown")).toThrowError(UnknownProviderError);
  });

  it("createDefaultProviderRegistry registers exactly Claude + DeepSeek today", () => {
    const registry = createDefaultProviderRegistry();
    expect([...registry.listIds()].sort()).toEqual(["claude", "deepseek"]);
  });
});
