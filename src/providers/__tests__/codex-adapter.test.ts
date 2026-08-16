import { describe, expect, it } from "vitest";
import { createProviderAdapter } from "../adapter.js";
import { codexProfile } from "../profiles/codex.js";
import { ProviderConfigError, UnknownModelAliasError } from "../errors.js";

describe("Codex adapter", () => {
  it("resolves the default model and known aliases (read from codex debug models)", () => {
    const adapter = createProviderAdapter(codexProfile);
    expect(adapter.resolveModel()).toBe("gpt-5.6-sol");
    expect(adapter.resolveModel("default")).toBe("gpt-5.6-sol");
    expect(adapter.resolveModel("terra")).toBe("gpt-5.6-terra");
    expect(adapter.resolveModel("luna")).toBe("gpt-5.6-luna");
    expect(adapter.resolveModel("mini")).toBe("gpt-5.4-mini");
  });

  it("throws UnknownModelAliasError for an unmapped alias", () => {
    const adapter = createProviderAdapter(codexProfile);
    expect(() => adapter.resolveModel("claude-sonnet-5")).toThrowError(UnknownModelAliasError);
  });

  it("is cli-session auth — refuses to fabricate a direct-API header (never stores/copies OAuth)", () => {
    const adapter = createProviderAdapter(codexProfile);
    expect(adapter.profile.auth.kind).toBe("cli-session");
    expect(() => adapter.buildAuthHeaders()).toThrowError(ProviderConfigError);
  });

  it("native CLI launch injects no credential and no CLAUDE config dir", () => {
    const adapter = createProviderAdapter(codexProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/work/CARS" });
    expect(plan.executable).toBe("codex");
    expect(plan.env).toEqual({});
    // Codex uses its native ~/.codex home — no Claude-specific configDir.
    expect(plan.configDir).toBeUndefined();
    // Defends against a leftover Claude/DeepSeek proxy session redirecting it.
    expect(plan.clearEnvVars).toEqual(expect.arrayContaining(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]));
  });

  it("reports capabilities honestly — extended thinking, tools, cliAvailable", () => {
    const adapter = createProviderAdapter(codexProfile);
    const caps = adapter.getCapabilities();
    expect(caps.protocol).toBe("openai-compatible");
    expect(caps.thinking).toBe("extended");
    expect(caps.tools).toBe(true);
    expect(caps.cliAvailable).toBe(true);
  });

  it("env/auth isolation: a leftover OPENAI_API_KEY is never injected by the launch plan", () => {
    process.env.OPENAI_API_KEY = "sk-openai-should-not-be-read-by-continuum";
    try {
      const adapter = createProviderAdapter(codexProfile);
      const plan = adapter.buildCliLaunchPlan({ workingDir: "/work" });
      // native launch sets no env; CONTINUUM neither injects nor echoes a key.
      expect(plan.env).toEqual({});
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});
