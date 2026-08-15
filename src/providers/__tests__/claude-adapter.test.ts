import { afterEach, describe, expect, it } from "vitest";
import { createProviderAdapter } from "../adapter.js";
import { claudeProfile } from "../profiles/claude.js";
import { MissingSecretError, ProviderConfigError, UnknownModelAliasError } from "../errors.js";

const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
});

describe("Claude adapter", () => {
  it("resolves the default model and known aliases", () => {
    const adapter = createProviderAdapter(claudeProfile);
    expect(adapter.resolveModel()).toBe("claude-sonnet-5");
    expect(adapter.resolveModel("default")).toBe("claude-sonnet-5");
    expect(adapter.resolveModel("fast")).toBe("claude-haiku-4-5-20251001");
    expect(adapter.resolveModel("opus")).toBe("claude-opus-5");
  });

  it("throws UnknownModelAliasError for an unmapped alias", () => {
    const adapter = createProviderAdapter(claudeProfile);
    expect(() => adapter.resolveModel("gpt-5")).toThrowError(UnknownModelAliasError);
  });

  it("builds x-api-key auth headers for a direct API call when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fixture-value";
    const adapter = createProviderAdapter(claudeProfile);
    const headers = adapter.buildAuthHeaders();
    expect(headers).toEqual({ "x-api-key": "sk-ant-test-fixture-value" });
    // Anthropic protocol must not also send a Bearer header.
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("fails clearly (MissingSecretError) when ANTHROPIC_API_KEY is unset — never fabricates a header", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const adapter = createProviderAdapter(claudeProfile);
    expect(() => adapter.buildAuthHeaders()).toThrowError(MissingSecretError);
  });

  it("CLI launch plan relies on the CLI's own session — no key is injected", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-appear-in-launch-plan";
    const adapter = createProviderAdapter(claudeProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project" });
    expect(plan.executable).toBe("claude");
    expect(plan.env).toEqual({});
    expect(plan.configDir).toBe(".claude-anthropic");
    // Defends against a leftover DeepSeek-proxy session redirecting native Claude.
    expect(plan.clearEnvVars).toEqual(expect.arrayContaining(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]));
  });

  it("a cli-session-only auth strategy would refuse to fabricate direct-call headers", () => {
    // Prove the failure mode generically (not Claude-specific): any profile
    // with auth.kind "cli-session" must reject buildAuthHeaders() rather
    // than silently returning an empty/fake header set.
    const cliOnlyProfile = { ...claudeProfile, auth: { kind: "cli-session" as const } };
    const adapter = createProviderAdapter(cliOnlyProfile);
    expect(() => adapter.buildAuthHeaders()).toThrowError(ProviderConfigError);
  });

  it("reports capabilities honestly — no unsupported capability is faked", () => {
    const adapter = createProviderAdapter(claudeProfile);
    const caps = adapter.getCapabilities();
    expect(caps.protocol).toBe("anthropic-messages");
    expect(caps.cliAvailable).toBe(true);
    expect(caps.thinking).toBe("extended");
  });
});
