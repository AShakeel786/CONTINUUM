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
    expect(profile.capabilities.cliAvailable).toBe(true);
    expect(profile.capabilities.contextWindowTokens).toBe(1_000_000);
    expect(profile.apiFallback).toBe(true);
    expect(profile.environment.owns).toContain("OPENROUTER_API_KEY");
    // Claude Code harness: redirected to OpenRouter's Anthropic-compatible
    // endpoint, with its own config dir and every tier mapped to the single
    // provider model on the wire.
    expect(profile.cliLaunch.kind).toBe("redirected");
    if (profile.cliLaunch.kind === "redirected") {
      expect(profile.cliLaunch.baseUrl).toBe("https://openrouter.ai/api");
      expect(profile.cliLaunch.configDirName).toBe(".claude-oxalpha");
      expect(profile.cliLaunch.clearEnvVars).toContain("ANTHROPIC_API_KEY");
      expect(profile.cliLaunch.permissionBypassFlag).toBe("--dangerously-skip-permissions");
      expect(profile.cliLaunch.modelTierMap).toEqual({ opus: "default", sonnet: "default", haiku: "default", subagent: "default" });
      expect(profile.cliLaunch.nativeResume?.supported).toBe(true);
    }
    // Limited-time free preview: no authoritative end date is published
    // upstream, so `until` is omitted rather than guessed.
    expect(profile.promo).toEqual({ note: "FREE" });
  });

  it("exposes API auth metadata (bearer env var), and no CLI auth", () => {
    const metadata = manifestToAuthMetadata(oxAlphaManifest);
    expect(metadata.providerId).toBe("ox-alpha");
    expect(metadata.api).toEqual({
      supported: true,
      envVar: "OPENROUTER_API_KEY",
      credentialRef: { providerId: "ox-alpha", name: "api-key" },
    });
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

  it("is registered by the default registry after the stable free API providers", () => {
    const registry = createProviderRegistry();
    expect(registry.has("ox-alpha")).toBe(true);
    const ids = registry.listIds();
    expect(ids[ids.length - 1]).toBe("ox-alpha");
    expect(bundledManifests[7]!.id).toBe("ox-alpha");
  });

  it("is a dual-harness provider: Claude Code CLI preferred, direct API when claude is missing", async () => {
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    const metadata = manifestToAuthMetadata(oxAlphaManifest);
    const credentialManager = new CredentialManager(new FakeBackend());
    const base = { cliAuthManager: new CliAuthManager(), credentialManager };
    const withCli = { ...base, findExecutable: (e: string) => (e === "claude" ? "/fake/claude" : undefined) };
    const withoutCli = { ...base, findExecutable: () => undefined };

    const noKey = await evaluateProvider(adapter, metadata, withoutCli);
    expect(noKey.usable).toBe(false);
    expect(noKey.launchKind).toBe("direct-api");

    await credentialManager.setCredential("ox-alpha", "api-key", FIXTURE_KEY);
    const cliHarness = await evaluateProvider(adapter, metadata, withCli);
    expect(cliHarness.usable).toBe(true);
    expect(cliHarness.launchKind).toBe("cli");
    const apiHarness = await evaluateProvider(adapter, metadata, withoutCli);
    expect(apiHarness.usable).toBe(true);
    expect(apiHarness.launchKind).toBe("direct-api");
  });

  it("builds the Claude Code launch plan: redirected env, wire-model overrides, no process.env mutation", () => {
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    const plan = adapter.buildCliLaunchPlan({
      workingDir: "/work/ox",
      secrets: { OPENROUTER_API_KEY: FIXTURE_KEY },
      taskPrompt: "hello",
      permissionMode: "bypass",
      setSessionId: "sess-1",
    });
    expect(plan.executable).toBe("claude");
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe(FIXTURE_KEY);
    expect(plan.env.ANTHROPIC_MODEL).toBe("sonnet"); // catalog-facing alias
    expect(plan.clearEnvVars).toContain("ANTHROPIC_API_KEY");
    expect(plan.configDir).toBe(".claude-oxalpha");
    expect(plan.args).toContain("--dangerously-skip-permissions");
    expect(plan.args).toContain("--session-id");
    const settingsArg = plan.args.find((a) => a.startsWith('{"statusLine"'));
    expect(settingsArg).toBeDefined();
    const settings = JSON.parse(settingsArg!);
    expect(settings.modelOverrides["claude-sonnet-5"]).toBe("stealth/ox-alpha");
    expect(settings.modelOverrides["claude-opus-5"]).toBe("stealth/ox-alpha");
    expect(settings.modelOverrides["claude-haiku-4-5"]).toBe("stealth/ox-alpha");
    // Env isolation: the plan is pure data — process.env was not mutated.
    const before = { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
    expect(process.env.ANTHROPIC_BASE_URL).toBe(before.ANTHROPIC_BASE_URL);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(before.ANTHROPIC_AUTH_TOKEN);
    expect(process.env.OPENROUTER_API_KEY).toBe(before.OPENROUTER_API_KEY);
  });

  it("builds resume args for the ox Claude Code harness", () => {
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    const plan = adapter.buildCliLaunchPlan({
      workingDir: "/work/ox",
      secrets: { OPENROUTER_API_KEY: FIXTURE_KEY },
      resumeNativeSessionId: "native-123",
    });
    expect(plan.args).toContain("--resume");
    expect(plan.args).toContain("native-123");
  });

  it("fails loudly (ProviderAuthError) when the ox credential is missing at launch time", () => {
    const adapter = createProviderAdapter(manifestToProfile(oxAlphaManifest));
    expect(() =>
      adapter.buildCliLaunchPlan({ workingDir: "/work/ox", secrets: {} }),
    ).toThrow(/cannot launch redirected session/);
  });

  it("keeps Ox Alpha after stable free APIs and before paid DeepSeek", () => {
    expect(DEFAULT_PROVIDER_PREFERENCE_CHAIN).toEqual([
      "gemini-free",
      "groq-free",
      "openrouter-free",
      "ox-alpha",
      "deepseek",
    ]);
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
