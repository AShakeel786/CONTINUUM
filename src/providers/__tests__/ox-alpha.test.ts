/**
 * Ox Alpha Free (OpenRouter) provider preset tests — manifest validity,
 * profile conversion, auth headers, registry inclusion, usability, promo.
 *
 * Secret handling: the only credential values here are fixtures in
 * `process.env` (set + deleted around each assertion) or in an in-memory
 * fake credential backend — never the real OS credential store, and never
 * a literal in this file's source beyond the obvious `sk-fixture-…` label.
 *
 * Live tool-use verification note: Ox Alpha's tool calling was verified
 * end-to-end through the real api-agent runtime (`session_update` + a
 * `session_state` read-back, with the note persisting in the session
 * store). Repo-file tool use was NOT applicable there: the API-agent tool
 * registry (`src/mcp/build.ts`) exposes session/memory/retrieval tools
 * only — no filesystem tools were added just to satisfy that check.
 */

import { describe, expect, it, afterEach } from "vitest";
import { oxAlphaManifest, DEFAULT_PROVIDER_PREFERENCE_CHAIN, bundledManifests } from "../presets.js";
import { validateManifest, manifestToProfile, manifestToAuthMetadata } from "../manifest.js";
import { createProviderAdapter } from "../adapter.js";
import { createProviderRegistry } from "../index.js";
import { isPromoActive, formatPromoLabel } from "../promo.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { evaluateProvider } from "../../launcher/usability.js";
import { UnknownModelAliasError } from "../errors.js";
import type { CredentialBackend } from "../../auth/types.js";

const FIXTURE_KEY = "sk-fixture-test-only";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test backend";
  private readonly store = new Map<string, string>();
  async isAvailable() { return true; }
  async set(key: string, value: string) { this.store.set(key, value); }
  async get(key: string) { return this.store.get(key); }
  async delete(key: string) { this.store.delete(key); }
  async list() { return [...this.store.keys()]; }
}

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});

describe("oxAlphaManifest (OpenRouter — Ox Alpha Free)", () => {
  it("is a valid manifest under the existing validator", () => {
    expect(validateManifest(oxAlphaManifest)).toEqual([]);
  });

  it("converts to a profile with the expected shape", () => {
    const profile = manifestToProfile(oxAlphaManifest);
    expect(profile.id).toBe("ox-alpha");
    expect(profile.displayName).toBe("Ox Alpha Free");
    expect(profile.protocol).toBe("openai-compatible");
    expect(profile.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(profile.models.default).toBe("stealth/ox-alpha");
    expect(profile.auth.kind).toBe("bearer-token");
    if (profile.auth.kind === "bearer-token") expect(profile.auth.secret.envVar).toBe("OPENROUTER_API_KEY");
    expect(profile.capabilities.cliAvailable).toBe(false);
    expect(profile.capabilities.contextWindowTokens).toBe(1_000_000);
    expect(profile.environment.owns).toContain("OPENROUTER_API_KEY");
    // Limited-time free preview: no authoritative end date is published
    // upstream, so `until` is omitted rather than guessed.
    expect(profile.promo).toEqual({ note: "FREE" });
  });

  it("exposes API auth metadata (bearer env var), and no CLI auth", () => {
    const metadata = manifestToAuthMetadata(oxAlphaManifest);
    expect(metadata.providerId).toBe("ox-alpha");
    expect(metadata.api).toEqual({ supported: true, envVar: "OPENROUTER_API_KEY" });
    expect(metadata.cli.supported).toBe(false);
  });

  it("resolves the default model and rejects unknown aliases", () => {
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    expect(adapter.resolveModel()).toBe("stealth/ox-alpha");
    expect(() => adapter.resolveModel("nope")).toThrow(UnknownModelAliasError);
  });

  it("buildAuthHeaders emits Authorization: Bearer from the env var (fixture set + deleted)", () => {
    process.env.OPENROUTER_API_KEY = FIXTURE_KEY;
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    expect(adapter.buildAuthHeaders()).toEqual({ Authorization: `Bearer ${FIXTURE_KEY}` });
    delete process.env.OPENROUTER_API_KEY;
  });

  it("buildAuthHeaders resolves from an injected env map without touching process.env", () => {
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    expect(adapter.buildAuthHeaders({ OPENROUTER_API_KEY: FIXTURE_KEY })).toEqual({ Authorization: `Bearer ${FIXTURE_KEY}` });
    // process.env was never needed: no fixture set, no global mutation.
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("is registered by the default registry (bundled last, after Antigravity)", () => {
    const registry = createProviderRegistry();
    expect(registry.has("ox-alpha")).toBe(true);
    const ids = registry.listIds();
    expect(ids[ids.length - 1]).toBe("ox-alpha");
    expect(bundledManifests[4]!.id).toBe("ox-alpha");
  });

  it("is a direct-API provider: usable with a stored key, otherwise not", async () => {
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    const metadata = manifestToAuthMetadata(oxAlphaManifest);
    const deps = { cliAuthManager: new CliAuthManager(), credentialManager: new CredentialManager(new FakeBackend()) };
    const withoutKey = await evaluateProvider(adapter, metadata, deps);
    expect(withoutKey.usable).toBe(false);
    expect(withoutKey.launchKind).toBe("direct-api");
    await deps.credentialManager.setCredential("ox-alpha", "api-key", FIXTURE_KEY);
    const withKey = await evaluateProvider(adapter, metadata, deps);
    expect(withKey.usable).toBe(true);
    expect(withKey.launchKind).toBe("direct-api");
  });

  it("declares the automatic preference chain as Ox Alpha first, DeepSeek second", () => {
    expect(DEFAULT_PROVIDER_PREFERENCE_CHAIN).toEqual(["ox-alpha", "deepseek"]);
  });
});

describe("promo helpers", () => {
  const withEnd = { until: "2026-08-27T23:59:59Z", note: "FREE" };
  const unknownEnd = { note: "FREE" };

  it("isPromoActive: declared `until` bounds activity; no `until` = active (unknown end, no guessed date)", () => {
    expect(isPromoActive(withEnd, Date.parse("2026-08-25T00:00:00Z"))).toBe(true);
    expect(isPromoActive(withEnd, Date.parse("2026-08-28T00:00:00Z"))).toBe(false);
    expect(isPromoActive(unknownEnd, Date.parse("2026-08-25T00:00:00Z"))).toBe(true);
    expect(isPromoActive(unknownEnd, Date.parse("2030-01-01T00:00:00Z"))).toBe(true);
  });

  it("formatPromoLabel: `until` renders a date; no `until` renders 'FREE · limited time'", () => {
    const dated = formatPromoLabel(withEnd, Date.parse("2026-08-25T00:00:00Z"));
    expect(dated).toBeDefined();
    expect(dated).toContain("FREE");
    expect(dated).toContain("until");
    expect(formatPromoLabel(unknownEnd, Date.parse("2026-08-25T00:00:00Z"))).toBe("FREE · limited time");
    expect(formatPromoLabel(withEnd, Date.parse("2026-08-28T00:00:00Z"))).toBeUndefined();
    expect(formatPromoLabel(undefined, Date.parse("2026-08-25T00:00:00Z"))).toBeUndefined();
  });
});
