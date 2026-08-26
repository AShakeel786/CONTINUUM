import { describe, expect, it, vi } from "vitest";
import { createProviderAdapter } from "../../providers/adapter.js";
import { manifestToProfile, type ProviderManifest } from "../../providers/manifest.js";
import { createApiRunner, type ApiRunner } from "../runner.js";
import { ApiFailoverExhaustedError, createFailoverApiRunner, type FailoverCandidate } from "../failover.js";
import { ApiAgentError, type AgentMessage, type AgentTurnResult } from "../types.js";

const msgs: AgentMessage[] = [{ role: "user", content: "hello" }];
const success: AgentTurnResult = { content: "done", toolCalls: [], finishReason: "stop" };

function adapterOf(manifest: ProviderManifest) {
  return createProviderAdapter(manifestToProfile(manifest));
}

function captureFetch(capture: (url: string, headers: Record<string, string>, body: string) => void) {
  return async (url: string, init?: RequestInit) => {
    capture(url, (init?.headers as Record<string, string>) ?? {}, String(init?.body ?? ""));
    return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }) };
  };
}

describe("static headers are merged into every wire request", () => {
  it("openai-compatible requests carry manifest static headers", async () => {
    let seen: Record<string, string> = {};
    const manifest: ProviderManifest = {
      schemaVersion: 1, id: "gh", displayName: "GitHub-like", protocol: "openai-compatible",
      baseUrl: "https://models.example/api", auth: { kind: "bearer-token", envVar: "GH_KEY" },
      models: { default: "m" }, staticHeaders: { "x-github-api-version": "2025-05-15" },
    };
    const runner = createApiRunner(adapterOf(manifest), {
      env: { GH_KEY: "fixture" },
      fetch: captureFetch((_u, h) => { seen = h; }),
    });
    await runner.call(msgs, []);
    expect(seen["x-github-api-version"]).toBe("2025-05-15");
    expect(seen.Authorization).toBe("Bearer fixture");
  });

  it("anthropic-messages requests keep anthropic-version and add static headers", async () => {
    let seen: Record<string, string> = {};
    const manifest: ProviderManifest = {
      schemaVersion: 1, id: "ant", displayName: "Ant-like", protocol: "anthropic-messages",
      baseUrl: "https://api.ant.example", auth: { kind: "api-key", envVar: "ANT_KEY" },
      models: { default: "m" }, staticHeaders: { "x-contract": "v2" },
    };
    const runner = createApiRunner(adapterOf(manifest), {
      env: { ANT_KEY: "fixture" },
      fetch: captureFetch((_u, h) => { seen = h; }),
    });
    await runner.call(msgs, []);
    expect(seen["anthropic-version"]).toBe("2023-06-01");
    expect(seen["x-contract"]).toBe("v2");
  });
});

describe("endpoint path params resolve from the (merged) environment", () => {
  it("substitutes a {paramName} placeholder from a declared env var", async () => {
    let url = "";
    const manifest: ProviderManifest = {
      schemaVersion: 1, id: "cf", displayName: "CF-like", protocol: "openai-compatible",
      baseUrl: "https://api.example.com/client/v4/accounts/{accountId}/ai/v1",
      auth: { kind: "bearer-token", envVar: "CF_KEY" },
      models: { default: "m" }, endpointParams: { accountId: "CF_ACCOUNT_ID" },
    };
    const runner = createApiRunner(adapterOf(manifest), {
      env: { CF_KEY: "fixture", CF_ACCOUNT_ID: "acct-123" },
      fetch: captureFetch((u) => { url = u; }),
    });
    await runner.call(msgs, []);
    expect(url).toContain("/client/v4/accounts/acct-123/ai/v1/chat/completions");
    expect(url).not.toContain("{accountId}");
  });

  it("throws a non-retryable config error when a required param is missing", async () => {
    const manifest: ProviderManifest = {
      schemaVersion: 1, id: "cf", displayName: "CF-like", protocol: "openai-compatible",
      baseUrl: "https://api.example.com/client/v4/accounts/{accountId}/ai/v1",
      auth: { kind: "bearer-token", envVar: "CF_KEY" },
      models: { default: "m" }, endpointParams: { accountId: "CF_ACCOUNT_ID" },
    };
    const runner = createApiRunner(adapterOf(manifest), { env: { CF_KEY: "fixture" } });
    const err = await runner.call(msgs, []).catch((e) => e);
    expect(err).toBeInstanceOf(ApiAgentError);
    expect(err.retryable).toBe(false);
    expect(String(err.message)).toContain("CF_ACCOUNT_ID");
  });

  it("rejects an undeclared placeholder as a config error, never a guessed URL", async () => {
    const manifest: ProviderManifest = {
      schemaVersion: 1, id: "bad", displayName: "Bad", protocol: "openai-compatible",
      baseUrl: "https://api.example.com/{oops}", auth: { kind: "bearer-token", envVar: "K" },
      models: { default: "m" },
    };
    const runner = createApiRunner(adapterOf(manifest), { env: { K: "fixture" } });
    const err = await runner.call(msgs, []).catch((e) => e);
    expect(err).toBeInstanceOf(ApiAgentError);
    expect(err.retryable).toBe(false);
    expect(String(err.message)).toContain("oops");
  });
});

function candidate(id: string, manifestOverrides: Partial<ProviderManifest>, runner: ApiRunner, extra?: Partial<FailoverCandidate>): FailoverCandidate {
  const manifest: ProviderManifest = {
    schemaVersion: 1, id, displayName: id.toUpperCase(), protocol: "openai-compatible",
    baseUrl: `https://${id}.example/v1`, auth: { kind: "bearer-token", envVar: `${id.toUpperCase()}_KEY` },
    models: { default: `${id}-model` }, capabilities: { tools: true }, ...manifestOverrides,
  };
  return { adapter: adapterOf(manifest), env: { [`${id.toUpperCase()}_KEY`]: "fixture" }, runner, ...extra };
}

function succeeding(): ApiRunner {
  return { call: vi.fn(async () => success) };
}
function neverCalled(): ApiRunner {
  return { call: vi.fn(async () => { throw new Error("must not be called"); }) };
}

describe("free-only pool gates on billing class AND pool eligibility", () => {
  it("skips a trial candidate in freeOnly mode (never calls it)", async () => {
    const trial = neverCalled();
    const free = succeeding();
    const runner = createFailoverApiRunner([
      candidate("cerebras", { billing: "trial" }, trial),
      candidate("gemini2", { billing: "free" }, free),
    ]);
    await expect(runner.call(msgs, [])).resolves.toEqual(success);
    expect(trial.call).not.toHaveBeenCalled();
    expect(free.call).toHaveBeenCalledTimes(1);
  });

  it("skips a free candidate declared not pool-eligible in freeOnly mode", async () => {
    const notEligible = neverCalled();
    const free = succeeding();
    const runner = createFailoverApiRunner([
      candidate("cf", { billing: "free", freeOnlyEligible: false }, notEligible),
      candidate("gemini2", { billing: "free" }, free),
    ]);
    await expect(runner.call(msgs, [])).resolves.toEqual(success);
    expect(notEligible.call).not.toHaveBeenCalled();
  });

  it("exhausts with an actionable reason when only non-pool-free candidates exist", async () => {
    const runner = createFailoverApiRunner([
      candidate("cerebras", { billing: "trial" }, succeeding()),
      candidate("cf", { billing: "free", freeOnlyEligible: false }, succeeding()),
    ]);
    const err = await runner.call(msgs, []).catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailoverExhaustedError);
    expect(String(err.message)).toContain("trial fallback not enabled");
    expect(String(err.message)).toContain("not eligible for the free pool");
  });

  it("allowPaid reaches trial/paid/not-eligible candidates and prefers them in order", async () => {
    const trial = succeeding();
    const runner = createFailoverApiRunner(
      [candidate("cerebras", { billing: "trial" }, trial)],
      { mode: "freeFirst", allowPaidFallback: true },
    );
    await expect(runner.call(msgs, [])).resolves.toEqual(success);
    expect(trial.call).toHaveBeenCalledTimes(1);
  });

  it("reports freeOnlyEligible and a pool-blocked reason in status()", async () => {
    const runner = createFailoverApiRunner([
      candidate("cerebras", { billing: "trial" }, succeeding()),
      candidate("cf", { billing: "free", freeOnlyEligible: false }, succeeding()),
    ]);
    const status = runner.status();
    const cerebras = status.find((s) => s.providerId === "cerebras");
    const cf = status.find((s) => s.providerId === "cf");
    expect(cerebras?.billing).toBe("trial");
    expect(cerebras?.freeOnlyEligible).toBe(false);
    expect(cerebras?.health).toBe("disabled");
    expect(cerebras?.failureReason).toBe("trial fallback not enabled");
    expect(cf?.billing).toBe("free");
    expect(cf?.freeOnlyEligible).toBe(false);
    expect(cf?.failureReason).toBe("not eligible for the free pool (free tier not verified for this account)");
  });

  it("a candidate whose endpoint param is missing fails fast without cycling the pool", async () => {
    const boom: ApiRunner = {
      call: vi.fn(async () => { throw new ApiAgentError("boom", { kind: "server-error", retryable: true }); }),
    };
    const runner = createFailoverApiRunner([
      candidate("cf", { billing: "free", freeOnlyEligible: false }, boom),
    ], { mode: "freeFirst", allowPaidFallback: true });
    const err = await runner.call(msgs, []).catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailoverExhaustedError);
    expect(boom.call).toHaveBeenCalledTimes(1);
  });
});
