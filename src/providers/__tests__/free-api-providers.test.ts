import { describe, expect, it, vi } from "vitest";
import { createApiRunner, type FetchLike } from "../../api-agent/runner.js";
import { createProviderAdapter } from "../adapter.js";
import { UnknownModelAliasError } from "../errors.js";
import { manifestToAuthMetadata, manifestToProfile, validateManifest } from "../manifest.js";
import {
  DEFAULT_PROVIDER_PREFERENCE_CHAIN,
  geminiFreeManifest,
  groqFreeManifest,
  openRouterFreeManifest,
} from "../presets.js";
import { createDefaultProviderRegistry } from "../index.js";

const FIXTURE_TOKEN = "fixture-token";
const manifests = [geminiFreeManifest, groqFreeManifest, openRouterFreeManifest] as const;

describe("bundled free API provider manifests", () => {
  it.each(manifests)("validates $id and preserves free/tools metadata", (manifest) => {
    expect(validateManifest(manifest)).toEqual([]);
    const profile = manifestToProfile(manifest);
    expect(profile.billing).toBe("free");
    expect(profile.capabilities.tools).toBe(true);
    expect(profile.protocol).toBe("openai-compatible");
    const auth = manifestToAuthMetadata(manifest);
    expect(manifest.auth.kind).toBe("bearer-token");
    if (manifest.auth.kind !== "bearer-token") throw new Error("test manifest must use bearer auth");
    expect(auth.api).toEqual({
      supported: true,
      envVar: manifest.auth.envVar,
      credentialRef: { providerId: manifest.id, name: "api-key" },
    });
    expect(auth.cli.supported).toBe(false);
  });

  it("declares the exact models, aliases, contexts, and endpoints", () => {
    expect(geminiFreeManifest).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      auth: { kind: "bearer-token", envVar: "GEMINI_API_KEY" },
      models: { default: "gemini-3.7-flash" },
      capabilities: { contextWindowTokens: 1_048_576 },
    });
    expect(groqFreeManifest).toMatchObject({
      baseUrl: "https://api.groq.com/openai/v1",
      auth: { kind: "bearer-token", envVar: "GROQ_API_KEY" },
      models: {
        default: "openai/gpt-oss-120b",
        aliases: { fast: "openai/gpt-oss-20b", qwen: "qwen/qwen3.6-27b" },
      },
    });
    expect(openRouterFreeManifest).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      auth: { kind: "bearer-token", envVar: "OPENROUTER_API_KEY" },
      models: { default: "openrouter/free" },
      capabilities: { contextWindowTokens: 200_000 },
    });
  });

  it.each([
    [geminiFreeManifest, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "GEMINI_API_KEY"],
    [groqFreeManifest, "https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY"],
    [openRouterFreeManifest, "https://openrouter.ai/api/v1/chat/completions", "OPENROUTER_API_KEY"],
  ] as const)("builds the exact $0.id chat-completions request", async (manifest, endpoint, envVar) => {
    const fetch: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    }));
    const runner = createApiRunner(createProviderAdapter(manifestToProfile(manifest)), {
      fetch,
      maxAttempts: 1,
      env: { [envVar]: FIXTURE_TOKEN },
    });

    await expect(runner.call([{ role: "user", content: "ping" }], [])).resolves.toMatchObject({ content: "ok" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init.headers.Authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(JSON.parse(init.body)).toMatchObject({ model: manifest.models.default, messages: [{ role: "user", content: "ping" }] });
  });

  it("resolves Groq aliases and each provider default", () => {
    const gemini = createProviderAdapter(manifestToProfile(geminiFreeManifest));
    const groq = createProviderAdapter(manifestToProfile(groqFreeManifest));
    const openRouter = createProviderAdapter(manifestToProfile(openRouterFreeManifest));
    expect(gemini.resolveModel()).toBe("gemini-3.7-flash");
    expect(groq.resolveModel()).toBe("openai/gpt-oss-120b");
    expect(groq.resolveModel("fast")).toBe("openai/gpt-oss-20b");
    expect(groq.resolveModel("qwen")).toBe("qwen/qwen3.6-27b");
    expect(openRouter.resolveModel()).toBe("openrouter/free");
  });

  it("cannot reach a paid model through openrouter-free", () => {
    const adapter = createProviderAdapter(manifestToProfile(openRouterFreeManifest));
    expect(openRouterFreeManifest.models.aliases).toBeUndefined();
    expect(() => adapter.resolveModel("openai/gpt-5")).toThrow(UnknownModelAliasError);
    expect(() => adapter.resolveModel("anthropic/claude-sonnet-4")).toThrow(UnknownModelAliasError);
  });

  it("registers all three provider IDs and uses the requested default pool order", () => {
    const registry = createDefaultProviderRegistry();
    for (const id of ["gemini-free", "groq-free", "openrouter-free"]) {
      expect(registry.has(id)).toBe(true);
      expect(registry.get(id).profile.billing).toBe("free");
    }
    expect(DEFAULT_PROVIDER_PREFERENCE_CHAIN).toEqual([
      "gemini-free",
      "groq-free",
      "openrouter-free",
      "ox-alpha",
      "deepseek",
    ]);
  });
});
