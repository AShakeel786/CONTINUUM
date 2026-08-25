import { describe, expect, it } from "vitest";
import {
  MANIFEST_SCHEMA_VERSION,
  manifestToAuthMetadata,
  manifestToProfile,
  validateManifest,
  type ProviderManifest,
} from "../manifest.js";
import { createProviderAdapter } from "../adapter.js";
import { createProviderRegistry } from "../index.js";

const grokManifest: ProviderManifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  id: "grok",
  displayName: "Grok",
  protocol: "openai-compatible",
  baseUrl: "https://api.x.ai/v1",
  auth: { kind: "api-key", envVar: "XAI_API_KEY" },
  models: { default: "grok-3" },
};

const glmManifest: ProviderManifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  id: "glm",
  displayName: "GLM (Zhipu)",
  protocol: "openai-compatible",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  auth: { kind: "api-key", envVar: "ZHIPU_API_KEY" },
  models: { default: "glm-4-plus" },
};

describe("validateManifest", () => {
  const hasError = (input: unknown, sub: string) => validateManifest(input).some((e) => e.includes(sub));

  it("accepts a minimal OpenAI-compatible API manifest", () => {
    expect(validateManifest(grokManifest)).toEqual([]);
  });

  it("rejects a wrong schema version", () => {
    expect(hasError({ ...grokManifest, schemaVersion: 2 }, "schemaVersion")).toBe(true);
  });

  it("rejects a bad id", () => {
    expect(hasError({ ...grokManifest, id: "Bad Id!" }, "id must match")).toBe(true);
  });

  it("rejects a bad base URL", () => {
    expect(hasError({ ...grokManifest, baseUrl: "not-a-url" }, "baseUrl")).toBe(true);
  });

  it("rejects an api-key auth with no env var", () => {
    expect(hasError({ ...grokManifest, auth: { kind: "api-key" } as never }, "auth.envVar")).toBe(true);
  });

  it("rejects a manifest containing an inline secret value", () => {
    const bad = { ...grokManifest, auth: { kind: "api-key", envVar: "sk-super-secret-key-value" } };
    expect(hasError(bad, "secret value")).toBe(true);
  });

  it("accepts a promo with a parseable `until` and a note", () => {
    const withPromo = { ...grokManifest, promo: { until: "2026-08-27T23:59:59Z", note: "FREE" } };
    expect(validateManifest(withPromo)).toEqual([]);
  });

  it("accepts a promo WITHOUT `until` (unknown end — reads as limited time, never a guessed date)", () => {
    expect(validateManifest({ ...grokManifest, promo: { note: "FREE" } })).toEqual([]);
  });

  it("rejects a promo with a non-date `until`", () => {
    expect(hasError({ ...grokManifest, promo: { until: "eventually", note: "FREE" } }, "promo.until")).toBe(true);
  });

  it("rejects a promo without a note", () => {
    expect(hasError({ ...grokManifest, promo: { until: "2026-08-27T23:59:59Z" } as never }, "promo.note")).toBe(true);
  });

  it("rejects a promo whose note carries a secret-shaped string", () => {
    expect(hasError({ ...grokManifest, promo: { until: "2026-08-27T23:59:59Z", note: "FREE sk-abcdefgh12345678" } }, "secret value")).toBe(true);
  });
});

describe("manifestToProfile + manifestToAuthMetadata (Grok/GLM proof)", () => {
  it("Grok becomes an OpenAI-compatible, API-key, direct-API provider", () => {
    const profile = manifestToProfile(grokManifest);
    expect(profile.id).toBe("grok");
    expect(profile.protocol).toBe("openai-compatible");
    expect(profile.auth.kind).toBe("api-key");
    expect(profile.capabilities.cliAvailable).toBe(false); // API-only

    const meta = manifestToAuthMetadata(grokManifest);
    expect(meta.api).toEqual({ supported: true, envVar: "XAI_API_KEY" });
    expect(meta.cli).toEqual({ supported: false });

    // Direct API auth (Bearer for openai-compatible), never a hardcoded key.
    process.env.XAI_API_KEY = "sk-fixture";
    const adapter = createProviderAdapter(profile);
    expect(adapter.resolveModel()).toBe("grok-3");
    expect(adapter.buildAuthHeaders()).toEqual({ Authorization: "Bearer sk-fixture" });
    delete process.env.XAI_API_KEY;
  });

  it("registers Grok and GLM through the manifest/registry path with zero source changes", () => {
    const registry = createProviderRegistry([grokManifest, glmManifest]);
    expect(registry.has("grok")).toBe(true);
    expect(registry.has("glm")).toBe(true);
    expect(registry.has("claude")).toBe(true); // bundled still present
    expect(registry.get("grok").resolveModel()).toBe("grok-3");
    expect(registry.get("glm").resolveModel()).toBe("glm-4-plus");
  });
});
