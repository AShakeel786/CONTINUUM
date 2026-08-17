import { afterEach, describe, expect, it } from "vitest";
import { createProviderAdapter } from "../adapter.js";
import { deepseekProfile } from "../profiles/deepseek.js";
import { claudeProfile } from "../profiles/claude.js";
import { MissingSecretError, ProviderAuthError, UnknownModelAliasError } from "../errors.js";

const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ORIGINAL_PROXY_KEY = process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  for (const [varName, original] of [
    ["DEEPSEEK_API_KEY", ORIGINAL_DEEPSEEK_API_KEY],
    ["CONTINUUM_TENCENT_PROXY_USER_KEY", ORIGINAL_PROXY_KEY],
    ["ANTHROPIC_API_KEY", ORIGINAL_ANTHROPIC_API_KEY],
  ] as const) {
    if (original === undefined) delete process.env[varName];
    else process.env[varName] = original;
  }
});

describe("DeepSeek adapter", () => {
  it("resolves the default model and the flash alias", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    expect(adapter.resolveModel()).toBe("deepseek-v4-pro");
    expect(adapter.resolveModel("flash")).toBe("deepseek-v4-flash");
  });

  it("throws UnknownModelAliasError for an unmapped alias", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.resolveModel("opus")).toThrowError(UnknownModelAliasError);
  });

  it("builds Bearer auth headers for a direct openai-compatible API call", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test-fixture-value";
    const adapter = createProviderAdapter(deepseekProfile);
    const headers = adapter.buildAuthHeaders();
    expect(headers).toEqual({ Authorization: "Bearer sk-deepseek-test-fixture-value" });
    expect(headers).not.toHaveProperty("x-api-key");
  });

  it("resolveCliLaunch defaults to the direct (redirected) descriptor and selects proxy on route=proxy", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    expect(adapter.resolveCliLaunch().kind).toBe("redirected");
    expect(adapter.resolveCliLaunch("direct").kind).toBe("redirected");
    expect(adapter.resolveCliLaunch("proxy").kind).toBe("proxy-routed");
  });

  it("direct CLI launch targets DeepSeek's own Anthropic endpoint and injects the upstream API key (never the Tencent proxy URL)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project" });
    expect(plan.executable).toBe("claude");
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-direct-fixture-key");
    expect(plan.env.ANTHROPIC_BASE_URL).not.toContain("127.0.0.1");
    expect(plan.configDir).toBe(".claude-deepseek");
  });

  it("direct launch never reads the proxy user key (no Tencent dependency)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
    process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = "sk-proxy-must-not-be-used";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "C:\\fake" });
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-direct-fixture-key");
  });

  it("proxy-routed CLI launch (route=proxy) targets the default proxy and injects the proxy-local key, not DeepSeek's own key", () => {
    process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = "sk-mem-test-fixture-proxy-key";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project", route: "proxy" });
    expect(plan.executable).toBe("claude");
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8096/claude-code/default");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-mem-test-fixture-proxy-key");
    expect(plan.configDir).toBe(".claude-tencent");
  });

  it("a provider-specific failure: missing proxy key surfaces as ProviderAuthError in proxy mode, not a generic error", () => {
    delete process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project", route: "proxy" })).toThrowError(
      ProviderAuthError,
    );
  });

  it("a provider-specific failure: missing upstream key surfaces as ProviderAuthError in direct mode", () => {
    delete process.env.DEEPSEEK_API_KEY;
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project" })).toThrowError(ProviderAuthError);
  });

  it("missing DEEPSEEK_API_KEY for a direct call fails as MissingSecretError, distinct from the launch-time ProviderAuthError case", () => {
    delete process.env.DEEPSEEK_API_KEY;
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.buildAuthHeaders()).toThrowError(MissingSecretError);
  });

  it("env/auth isolation: DeepSeek's launch never reads Claude's ANTHROPIC_API_KEY, and vice versa", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-belongs-to-claude-only";
    delete process.env.DEEPSEEK_API_KEY;
    const deepseekAdapter = createProviderAdapter(deepseekProfile);
    // DeepSeek's direct launch has its own secret requirement and must still
    // fail even though an unrelated provider's key is present in env — proves
    // no accidental cross-provider fallback.
    expect(() => deepseekAdapter.buildCliLaunchPlan({ workingDir: "C:\\fake" })).toThrowError(ProviderAuthError);

    process.env.DEEPSEEK_API_KEY = "sk-deepseek-only";
    delete process.env.ANTHROPIC_API_KEY;
    const claudeAdapter = createProviderAdapter(claudeProfile);
    // Claude's direct-call auth must still fail even though DeepSeek's key is
    // present — proves the reverse direction too.
    expect(() => claudeAdapter.buildAuthHeaders()).toThrowError(MissingSecretError);
  });

  it("reports capabilities honestly, including the thinking-block caveat", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    const caps = adapter.getCapabilities();
    expect(caps.protocol).toBe("openai-compatible");
    expect(caps.thinking).toBe("supported");
    expect(caps.cliAvailable).toBe(true);
  });
});
