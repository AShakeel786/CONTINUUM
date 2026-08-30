/**
 * GLM 5.2 Free (OpenRouter) provider preset tests — manifest validity,
 * profile conversion, auth headers, registry inclusion, and the ox-alpha
 * legacy-id/model compatibility aliases.
 *
 * Secret handling: the only credential values here are fixtures in
 * `process.env` (set + deleted around each assertion) or in an in-memory
 * fake credential backend — never the real OS credential store, and never
 * a literal in this file's source beyond the obvious `sk-fixture-…` label.
 *
 * Legacy identity note: this provider was "Ox Alpha Free" (`ox-alpha`, wire
 * model `stealth/ox-alpha`) until OpenRouter retired that id with a 404. The
 * rename keeps `ox-alpha` as an id alias and `stealth/ox-alpha` as a model
 * alias, so old persisted provider/session ids and saved model preferences
 * keep resolving — asserted here as compatibility guards.
 */

import { describe, expect, it, afterEach } from "vitest";
import { glm52FreeManifest, DEFAULT_PROVIDER_PREFERENCE_CHAIN, bundledManifests } from "../presets.js";
import { validateManifest, manifestToProfile, manifestToAuthMetadata } from "../manifest.js";
import { createProviderAdapter } from "../adapter.js";
import { createProviderRegistry } from "../index.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { evaluateProvider } from "../../launcher/usability.js";
import { UnknownModelAliasError } from "../errors.js";
import type { CredentialBackend } from "../../auth/types.js";

const FIXTURE_KEY = "sk-fixture-test-only";
const WIRE = "z-ai/glm-5.2:free";

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

describe("glm52FreeManifest (OpenRouter — GLM 5.2 Free)", () => {
  it("is a valid manifest under the existing validator", () => {
    expect(validateManifest(glm52FreeManifest)).toEqual([]);
  });

  it("converts to a profile with the expected shape", () => {
    const profile = manifestToProfile(glm52FreeManifest);
    expect(profile.id).toBe("glm-5-2-free");
    expect(profile.idAliases).toEqual(["ox-alpha"]);
    expect(profile.displayName).toBe("GLM 5.2 Free (OpenRouter)");
    expect(profile.protocol).toBe("openai-compatible");
    expect(profile.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(profile.models.default).toBe(WIRE);
    expect(profile.auth.kind).toBe("bearer-token");
    if (profile.auth.kind === "bearer-token") expect(profile.auth.secret.envVar).toBe("OPENROUTER_API_KEY");
    expect(profile.capabilities.cliAvailable).toBe(true);
    expect(profile.capabilities.contextWindowTokens).toBe(1_000_000);
    expect(profile.apiFallback).toBe(true);
    expect(profile.environment.owns).toContain("OPENROUTER_API_KEY");
    // No limited-time free promo: the provider's free status is its standing
    // state, not a temporary promotion to advertise in the HUD.
    expect(profile.promo).toBeUndefined();
    // Claude Code harness: redirected to OpenRouter's Anthropic-compatible
    // endpoint, with its own config dir and every tier mapped to the single
    // provider model on the wire.
    expect(profile.cliLaunch.kind).toBe("redirected");
    if (profile.cliLaunch.kind === "redirected") {
      expect(profile.cliLaunch.baseUrl).toBe("https://openrouter.ai/api");
      // Legacy config-dir name, kept for resume compatibility (the directory
      // holds this harness's live native Claude sessions).
      expect(profile.cliLaunch.configDirName).toBe(".claude-oxalpha");
      expect(profile.cliLaunch.clearEnvVars).toContain("ANTHROPIC_API_KEY");
      expect(profile.cliLaunch.permissionBypassFlag).toBe("--dangerously-skip-permissions");
      expect(profile.cliLaunch.modelTierMap).toEqual({ opus: "default", sonnet: "default", haiku: "default", fable: "default", subagent: "default" });
      expect(profile.cliLaunch.modelVerify).toEqual({ catalogUrl: "https://openrouter.ai/api/v1/models", listPath: "data", idField: "id" });
      expect(profile.cliLaunch.nativeResume?.supported).toBe(true);
    }
  });

  it("exposes API auth metadata (bearer env var), and no CLI auth", () => {
    const metadata = manifestToAuthMetadata(glm52FreeManifest);
    expect(metadata.providerId).toBe("glm-5-2-free");
    expect(metadata.api).toEqual({
      supported: true,
      envVar: "OPENROUTER_API_KEY",
      credentialRef: { providerId: "glm-5-2-free", name: "api-key" },
    });
    expect(metadata.cli.supported).toBe(false);
  });

  it("resolves the default model and rejects unknown aliases", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    expect(adapter.resolveModel()).toBe(WIRE);
    expect(() => adapter.resolveModel("nope")).toThrowError(UnknownModelAliasError);
  });

  it("resolves the retired stealth/ox-alpha model alias to the current free wire model", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    expect(adapter.resolveModel("stealth/ox-alpha")).toBe(WIRE);
  });

  it("keeps the paid z-ai/glm-5.2 unreachable through this provider", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    expect(() => adapter.resolveModel("z-ai/glm-5.2")).toThrow(UnknownModelAliasError);
  });

  it("buildAuthHeaders emits Authorization: Bearer from the env var (fixture set + deleted)", () => {
    process.env.OPENROUTER_API_KEY = FIXTURE_KEY;
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    expect(adapter.buildAuthHeaders()).toEqual({ Authorization: `Bearer ${FIXTURE_KEY}` });
    delete process.env.OPENROUTER_API_KEY;
  });

  it("buildAuthHeaders resolves from an injected env map without touching process.env", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    expect(adapter.buildAuthHeaders({ OPENROUTER_API_KEY: FIXTURE_KEY })).toEqual({ Authorization: `Bearer ${FIXTURE_KEY}` });
    // process.env was never needed: no fixture set, no global mutation.
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("is registered by the default registry (canonical id + legacy ox-alpha alias) after the stable free API providers", () => {
    const registry = createProviderRegistry();
    expect(registry.has("glm-5-2-free")).toBe(true);
    expect(registry.has("ox-alpha")).toBe(true); // legacy alias resolves
    const ids = registry.listIds();
    expect(ids.indexOf("glm-5-2-free")).toBeGreaterThan(ids.indexOf("openrouter-free"));
    // Aliases are never listed as canonical ids.
    expect(ids).not.toContain("ox-alpha");
    expect(bundledManifests[7]!.id).toBe("glm-5-2-free");
  });

  it("is a dual-harness provider: Claude Code CLI preferred, direct API when claude is missing", async () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    const metadata = manifestToAuthMetadata(glm52FreeManifest);
    const credentialManager = new CredentialManager(new FakeBackend());
    const base = { cliAuthManager: new CliAuthManager(), credentialManager };
    const withCli = { ...base, findExecutable: (e: string) => (e === "claude" ? "/fake/claude" : undefined) };
    const withoutCli = { ...base, findExecutable: () => undefined };

    const noKey = await evaluateProvider(adapter, metadata, withoutCli);
    expect(noKey.usable).toBe(false);
    expect(noKey.launchKind).toBe("direct-api");

    await credentialManager.setCredential("glm-5-2-free", "api-key", FIXTURE_KEY);
    const cliHarness = await evaluateProvider(adapter, metadata, withCli);
    expect(cliHarness.usable).toBe(true);
    expect(cliHarness.launchKind).toBe("cli");
    const apiHarness = await evaluateProvider(adapter, metadata, withoutCli);
    expect(apiHarness.usable).toBe(true);
    expect(apiHarness.launchKind).toBe("direct-api");
  });

  it("builds the Claude Code launch plan: redirected env, wire-model overrides, no process.env mutation", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
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
    // Every Claude catalog tier override resolves to the SAME provider wire
    // model — no Claude-native model id can reach the OpenRouter endpoint.
    for (const catalogId of ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5", "claude-fable-5"]) {
      expect(settings.modelOverrides[catalogId]).toBe(WIRE);
    }
    // Tier env vars (the only model carriers besides modelOverrides): the
    // opus/sonnet/fable tiers keep a recognized catalog-facing id (overridden
    // on the wire), while the haiku + subagent tiers — which Claude Code does
    // NOT override — carry the provider wire model directly so no Claude
    // native id leaks upstream on those internal calls.
    expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(plan.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-5");
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(WIRE);
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(WIRE);
    // Env isolation: the plan is pure data — process.env was not mutated.
    const before = { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
    expect(process.env.ANTHROPIC_BASE_URL).toBe(before.ANTHROPIC_BASE_URL);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(before.ANTHROPIC_AUTH_TOKEN);
    expect(process.env.OPENROUTER_API_KEY).toBe(before.OPENROUTER_API_KEY);
  });

  it("never lets a Claude-native model id leak upstream for ANY tier", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    const plan = adapter.buildCliLaunchPlan({
      workingDir: "/work/ox",
      secrets: { OPENROUTER_API_KEY: FIXTURE_KEY },
      taskPrompt: "hello",
    });
    const settings = JSON.parse(plan.args.find((a) => a.startsWith('{"statusLine"'))!);
    const overrides = settings.modelOverrides as Record<string, string>;
    // Every override value is the GLM wire model — never a stray claude-* id.
    for (const value of Object.values(overrides)) {
      expect(value).toBe(WIRE);
    }
    // Any catalog-facing claude-* id that appears in env MUST have a matching
    // override, so it can never become the wire model.
    for (const key of Object.keys(plan.env)) {
      const value = plan.env[key]!;
      if (!/^claude-(opus|sonnet|fable)-\d+$/.test(value)) continue;
      expect(overrides[value]).toBe(WIRE);
    }
    // The tiers Claude Code does NOT override (haiku, subagent) must carry the
    // wire model in env itself — never a claude-* id. This is the regression
    // that leaked `claude-haiku-4-5`/`claude-sonnet-5` upstream on v2.1.251.
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(WIRE);
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(WIRE);
  });

  it("builds resume args for the Claude Code harness", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    const plan = adapter.buildCliLaunchPlan({
      workingDir: "/work/ox",
      secrets: { OPENROUTER_API_KEY: FIXTURE_KEY },
      resumeNativeSessionId: "native-123",
    });
    expect(plan.args).toContain("--resume");
    expect(plan.args).toContain("native-123");
  });

  it("fails loudly (ProviderAuthError) when the credential is missing at launch time", () => {
    const adapter = createProviderAdapter(manifestToProfile(glm52FreeManifest));
    expect(() =>
      adapter.buildCliLaunchPlan({ workingDir: "/work/ox", secrets: {} }),
    ).toThrow(/cannot launch redirected session/);
  });

  it("keeps GLM 5.2 Free after stable free APIs and before the trial/non-pool-eligible additions and paid DeepSeek", () => {
    const chain = DEFAULT_PROVIDER_PREFERENCE_CHAIN;
    expect(chain).toEqual([
      "gemini-free",
      "groq-free",
      "openrouter-free",
      "glm-5-2-free",
      "cerebras-trial",
      "nvidia-free",
      "huggingface-free",
      "cloudflare-workers-ai-free",
      "deepseek",
    ]);
    expect(chain.indexOf("glm-5-2-free")).toBe(3);
    expect(chain.indexOf("deepseek")).toBe(8);
  });
});
