import { describe, expect, it, vi } from "vitest";
import { createApiRunner, type FetchLike } from "../../api-agent/runner.js";
import { createProviderAdapter } from "../adapter.js";
import { UnknownModelAliasError } from "../errors.js";
import { manifestToAuthMetadata, manifestToProfile, validateManifest } from "../manifest.js";
import {
  DEFAULT_PROVIDER_PREFERENCE_CHAIN,
  cerebrasTrialManifest,
  cloudflareWorkersAiFreeManifest,
  geminiFreeManifest,
  groqFreeManifest,
  huggingFaceFreeManifest,
  nvidiaFreeManifest,
  openRouterFreeManifest,
} from "../presets.js";
import { createDefaultProviderRegistry } from "../index.js";
import { resolveEndpointUrl } from "../endpoint.js";

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

  it("registers the pool providers and keeps the stable free pool first in the chain", () => {
    const registry = createDefaultProviderRegistry();
    for (const id of ["gemini-free", "groq-free", "openrouter-free", "glm-5-2-free"]) {
      expect(registry.has(id)).toBe(true);
      expect(registry.get(id).profile.billing).toBe("free");
    }
    // Stable free pool is preferred first, unchanged. The trial/non-pool-
    // eligible additions slot in BEFORE paid DeepSeek so they participate
    // ahead of paid under explicit paid-fallback — never in default freeOnly.
    expect(DEFAULT_PROVIDER_PREFERENCE_CHAIN).toEqual([
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
  });
});

describe("Phase 2B bundled providers (trial / free-not-pool-eligible)", () => {
  it.each([
    ["cerebras-trial", "trial", undefined],
    ["nvidia-free", "trial", undefined],
    ["huggingface-free", "trial", undefined],
    ["cloudflare-workers-ai-free", "free", false],
  ] as const)("registers %s with the safe billing classification", (id, billing, freeOnlyEligible) => {
    const registry = createDefaultProviderRegistry();
    expect(registry.has(id)).toBe(true);
    const profile = registry.get(id).profile;
    expect(profile.billing).toBe(billing);
    if (freeOnlyEligible === undefined) {
      expect(profile.freeOnlyEligible).toBeUndefined();
    } else {
      expect(profile.freeOnlyEligible).toBe(false);
    }
    // None of the new providers joins the automatic free-only pool by default.
    expect(profile.billing === "free" && profile.freeOnlyEligible !== false).toBe(false);
  });

  it("validates all four new bundled manifests", () => {
    for (const m of [cerebrasTrialManifest, nvidiaFreeManifest, huggingFaceFreeManifest, cloudflareWorkersAiFreeManifest]) {
      expect(validateManifest(m)).toEqual([]);
    }
  });

  it("Cerebras uses the confirmed free-trial model and endpoint", () => {
    expect(cerebrasTrialManifest).toMatchObject({
      baseUrl: "https://api.cerebras.ai/v1",
      auth: { kind: "bearer-token", envVar: "CEREBRAS_API_KEY" },
      billing: "trial",
      models: { default: "gpt-oss-120b" },
    });
  });

  it("NVIDIA and HuggingFace use their OpenAI-compatible routers with token auth", () => {
    expect(nvidiaFreeManifest).toMatchObject({
      baseUrl: "https://integrate.api.nvidia.com/v1",
      auth: { kind: "bearer-token", envVar: "NVIDIA_API_KEY" },
      billing: "trial",
    });
    expect(huggingFaceFreeManifest).toMatchObject({
      baseUrl: "https://router.huggingface.co/v1",
      auth: { kind: "bearer-token", envVar: "HF_TOKEN" },
      billing: "trial",
    });
  });

  it("Cloudflare requires a non-secret account_id endpoint param", () => {
    const manifest = cloudflareWorkersAiFreeManifest;
    expect(manifest.endpointParams).toEqual({ account_id: "CLOUDFLARE_ACCOUNT_ID" });
    expect(manifest.billing).toBe("free");
    expect(manifest.freeOnlyEligible).toBe(false);

    const profile = manifestToProfile(manifest);
    const url = resolveEndpointUrl(profile.baseUrl, profile, { CLOUDFLARE_ACCOUNT_ID: "acct-abc" });
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-abc/ai/v1");
    expect(() => resolveEndpointUrl(profile.baseUrl, profile, {})).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("auth metadata is provider-scoped (never a shared/OpenRouter alias) for the new providers", () => {
    for (const m of [cerebrasTrialManifest, nvidiaFreeManifest, huggingFaceFreeManifest, cloudflareWorkersAiFreeManifest]) {
      const auth = manifestToAuthMetadata(m);
      if (!auth.api.supported) throw new Error("new bundled provider must declare api auth");
      expect(auth.api.credentialRef).toEqual({ providerId: m.id, name: "api-key" });
      expect(auth.cli.supported).toBe(false);
    }
  });
});
