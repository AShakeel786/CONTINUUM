import { describe, expect, it } from "vitest";
import { createApiRunner, type FetchLike } from "../runner.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { ApiAgentError, type AgentMessage } from "../types.js";
import type { ProviderManifest } from "../../providers/manifest.js";

const grokManifest: ProviderManifest = {
  schemaVersion: 1, id: "grok", displayName: "Grok", protocol: "openai-compatible",
  baseUrl: "https://api.x.ai/v1", auth: { kind: "api-key", envVar: "XAI_API_KEY" }, models: { default: "grok-3" },
};
const anthropicManifest: ProviderManifest = {
  schemaVersion: 1, id: "ant", displayName: "Anthropic-like", protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com", auth: { kind: "api-key", envVar: "ANTHROPIC_API_KEY" }, models: { default: "claude-x" },
};

function fakeFetch(respond: (url: string, body: string) => { status: number; body: string }): FetchLike {
  return async (url, init) => {
    const { status, body } = respond(url, init.body);
    return { ok: status >= 200 && status < 300, status, body };
  };
}

const msgs: AgentMessage[] = [{ role: "user", content: "hello" }];

describe("OpenAI-compatible runner", () => {
  it("posts to /chat/completions with Bearer auth and parses content + tool calls", async () => {
    let captured = "";
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, {
      fetch: fakeFetch((url, body) => {
        captured = `${url}\n${body}`;
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "hi", tool_calls: [{ id: "t1", function: { name: "memory_search", arguments: "{\"query\":\"x\"}" } }] }, finish_reason: "tool_calls" }] }) };
      }),
    });
    const result = await runner.call(msgs, []);
    delete process.env.XAI_API_KEY;

    expect(captured).toContain("/chat/completions");
    expect(captured).toContain("grok-3");
    expect(result.content).toBe("hi");
    expect(result.toolCalls).toEqual([{ id: "t1", name: "memory_search", arguments: "{\"query\":\"x\"}" }]);
  });

  it("throws a clear error on a non-2xx (bad key/endpoint)", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, { fetch: async () => ({ ok: false, status: 401, body: "invalid key" }) });
    await expect(runner.call(msgs, [])).rejects.toThrow(ApiAgentError);
    await expect(runner.call(msgs, [])).rejects.toThrow(/401/);
    delete process.env.XAI_API_KEY;
  });
});

describe("network failure classification + bounded retry", () => {
  it("classifies a connection-refused exception, retries with backoff, and recovers", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const sleeps: number[] = [];
    const retries: { attempt: number; kind: string }[] = [];
    const runner = createApiRunner(adapter, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (info) => retries.push({ attempt: info.attempt, kind: info.kind }),
      fetch: async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("connect ECONNREFUSED 127.0.0.1:8096");
          (err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
          throw err;
        }
        return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] }) };
      },
    });
    const result = await runner.call(msgs, []);
    delete process.env.XAI_API_KEY;

    expect(calls).toBe(3);
    expect(result.content).toBe("recovered");
    expect(retries).toEqual([
      { attempt: 1, kind: "connection-refused" },
      { attempt: 2, kind: "connection-refused" },
    ]);
    expect(sleeps.length).toBe(2);
    // Bounded exponential-ish backoff, not a flat/instant retry.
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("stops retrying once maxAttempts is exhausted (bounded, no infinite loop)", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const runner = createApiRunner(adapter, {
      maxAttempts: 3,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        const err = new Error("connect ECONNREFUSED");
        (err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
        throw err;
      },
    });
    await expect(runner.call(msgs, [])).rejects.toThrow(ApiAgentError);
    delete process.env.XAI_API_KEY;
    expect(calls).toBe(3); // exactly maxAttempts — never more
  });

  it("classifies a timeout (AbortError) as retryable", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const runner = createApiRunner(adapter, {
      maxAttempts: 1,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    const err = await runner.call(msgs, []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiAgentError);
    expect((err as InstanceType<typeof ApiAgentError>).kind).toBe("timeout");
    expect((err as InstanceType<typeof ApiAgentError>).retryable).toBe(true);
  });

  it("classifies a DNS failure (ENOTFOUND) distinctly from connection-refused", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, {
      maxAttempts: 1,
      sleep: async () => {},
      fetch: async () => {
        const err = new Error("getaddrinfo ENOTFOUND api.x.ai");
        (err as unknown as { cause: { code: string } }).cause = { code: "ENOTFOUND" };
        throw err;
      },
    });
    const err = (await runner.call(msgs, []).catch((e: unknown) => e)) as InstanceType<typeof ApiAgentError>;
    expect(err.kind).toBe("dns");
    expect(err.retryable).toBe(true);
  });

  it("classifies a TLS/certificate failure as non-retryable (a retry can't fix a bad cert)", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const runner = createApiRunner(adapter, {
      maxAttempts: 5,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        const err = new Error("unable to verify the first certificate");
        (err as unknown as { cause: { code: string } }).cause = { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
        throw err;
      },
    });
    const err = (await runner.call(msgs, []).catch((e: unknown) => e)) as InstanceType<typeof ApiAgentError>;
    expect(err.kind).toBe("tls");
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1); // never retried
  });

  it("does not retry a 401 (auth) — non-retryable, fails on first attempt", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const runner = createApiRunner(adapter, {
      maxAttempts: 5,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return { ok: false, status: 401, body: "invalid key" };
      },
    });
    const err = (await runner.call(msgs, []).catch((e: unknown) => e)) as InstanceType<typeof ApiAgentError>;
    delete process.env.XAI_API_KEY;
    expect(err.kind).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not retry a non-retryable 4xx (e.g. 400 bad request) — a config problem, not transient", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const runner = createApiRunner(adapter, {
      maxAttempts: 5,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return { ok: false, status: 400, body: "malformed request" };
      },
    });
    const err = (await runner.call(msgs, []).catch((e: unknown) => e)) as InstanceType<typeof ApiAgentError>;
    delete process.env.XAI_API_KEY;
    expect(err.kind).toBe("http-error");
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it("retries a 429 and honors the Retry-After header instead of computed backoff", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const sleeps: number[] = [];
    const runner = createApiRunner(adapter, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        calls++;
        if (calls === 1) return { ok: false, status: 429, body: "slow down", retryAfterMs: 7000 };
        return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) };
      },
    });
    await runner.call(msgs, []);
    delete process.env.XAI_API_KEY;
    expect(sleeps).toEqual([7000]);
    expect(calls).toBe(2);
  });

  it("retries a 5xx server error and eventually gives up with a classified error", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-fixture";
    let calls = 0;
    const runner = createApiRunner(adapter, {
      maxAttempts: 2,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return { ok: false, status: 503, body: "upstream overloaded" };
      },
    });
    const err = (await runner.call(msgs, []).catch((e: unknown) => e)) as InstanceType<typeof ApiAgentError>;
    delete process.env.XAI_API_KEY;
    expect(err.kind).toBe("server-error");
    expect(calls).toBe(2);
  });

  it("never leaks the Authorization/API-key header in a classified error message", async () => {
    const adapter = createProviderAdapter(manifestToProfile(grokManifest));
    process.env.XAI_API_KEY = "sk-super-secret-value";
    const runner = createApiRunner(adapter, {
      maxAttempts: 1,
      sleep: async () => {},
      fetch: async () => ({ ok: false, status: 401, body: "invalid key" }),
    });
    const err = (await runner.call(msgs, []).catch((e: unknown) => e)) as InstanceType<typeof ApiAgentError>;
    delete process.env.XAI_API_KEY;
    expect(err.message).not.toContain("sk-super-secret-value");
    expect(err.host).not.toContain("sk-super-secret-value");
  });

  it("reports host:port, not the full request URL/path", async () => {
    const adapter = createProviderAdapter(manifestToProfile(anthropicManifest));
    process.env.ANTHROPIC_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, {
      maxAttempts: 1,
      sleep: async () => {},
      fetch: async () => {
        const err = new Error("connect ECONNREFUSED");
        (err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
        throw err;
      },
    });
    const err = (await runner.call(msgs, []).catch((e: unknown) => e)) as InstanceType<typeof ApiAgentError>;
    delete process.env.ANTHROPIC_API_KEY;
    expect(err.host).toBe("api.anthropic.com:443");
  });
});

describe("Anthropic-compatible runner", () => {
  it("posts to /v1/messages and parses text + tool_use blocks", async () => {
    let captured = "";
    const adapter = createProviderAdapter(manifestToProfile(anthropicManifest));
    process.env.ANTHROPIC_API_KEY = "sk-fixture";
    const runner = createApiRunner(adapter, {
      fetch: fakeFetch((url, body) => {
        captured = `${url}\n${body}`;
        return { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "answer" }, { type: "tool_use", id: "tu1", name: "memory_recall", input: {} }], stop_reason: "tool_use" }) };
      }),
    });
    const result = await runner.call([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], []);
    delete process.env.ANTHROPIC_API_KEY;

    expect(captured).toContain("/v1/messages");
    expect(captured).toContain("claude-x");
    expect(result.content).toBe("answer");
    expect(result.toolCalls).toEqual([{ id: "tu1", name: "memory_recall", arguments: "{}" }]);
  });
});
