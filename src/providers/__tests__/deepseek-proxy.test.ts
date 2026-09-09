import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepSeekProxy } from "../deepseek-proxy.js";

const ARTIFACT_PATTERN = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$";
const ARTIFACT_PATTERN_SANITIZED = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./\\[\\]]{1,200}$";

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
  authHeader: string | undefined;
}

/** Mock DeepSeek upstream: records what the proxy forwards, replies canned. */
async function startMockUpstream(): Promise<{ server: Server; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body, authHeader: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"type":"message","content":[{"type":"text","text":"ok"}]}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  return { server, captured };
}

function artifactRequestBody(stream = false): Record<string, unknown> {
  return {
    model: "deepseek-v4-pro[1m]",
    max_tokens: 8,
    stream,
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "Artifact",
        description: "test",
        input_schema: {
          type: "object",
          properties: { field: { type: "string", pattern: ARTIFACT_PATTERN } },
          required: ["field"],
        },
      },
    ],
  };
}

describe("deepseek-proxy", () => {
  it("serves /health without forwarding", async () => {
    const upstream = await startMockUpstream();
    const proxy = await createDeepSeekProxy({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}` });
    openServers.push(proxy);
    const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, upstream: `http://127.0.0.1:${portOf(upstream.server)}` });
    expect(upstream.captured).toHaveLength(0);
  });

  it("sanitizes the Artifact tool schema before forwarding; upstream 200 is relayed", async () => {
    const upstream = await startMockUpstream();
    const activities: { statusCode: number; patternsChanged: number }[] = [];
    const proxy = await createDeepSeekProxy({
      port: 0,
      upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
      onActivity: (a) => activities.push({ statusCode: a.statusCode, patternsChanged: a.patternsChanged }),
    });
    openServers.push(proxy);

    const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test-not-a-real-key", "x-api-key": "sk-test-not-a-real-key" },
      body: JSON.stringify(artifactRequestBody()),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"ok"');
    expect(upstream.captured).toHaveLength(1);
    const forwarded = JSON.parse(upstream.captured[0]!.body) as {
      tools: { input_schema: { properties: { field: { pattern: string } } } }[];
    };
    expect(forwarded.tools[0]!.input_schema.properties.field.pattern).toBe(ARTIFACT_PATTERN_SANITIZED);
    expect(upstream.captured[0]!.body).not.toContain(ARTIFACT_PATTERN);
    // Auth relayed transparently to the upstream (never logged — the activity
    // callback carries only method/path/status/counts).
    expect(upstream.captured[0]!.authHeader).toBe("Bearer sk-test-not-a-real-key");
    expect(activities).toEqual([{ statusCode: 200, patternsChanged: 1 }]);
  });

  it("forwards requests without tool schemas byte-for-byte", async () => {
    const upstream = await startMockUpstream();
    const proxy = await createDeepSeekProxy({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}` });
    openServers.push(proxy);

    const body = JSON.stringify({ model: "deepseek-v4-pro[1m]", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(upstream.captured[0]!.body).toBe(body);
  });

  it("relays streaming SSE responses from the upstream", async () => {
    const upstream = await startMockUpstream();
    // Re-wire the mock to stream SSE for this test.
    upstream.server.removeAllListeners("request");
    upstream.server.on("request", (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        upstream.captured.push({ method: req.method ?? "", url: req.url ?? "", body, authHeader: req.headers.authorization });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });

    const proxy = await createDeepSeekProxy({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}` });
    openServers.push(proxy);

    const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(artifactRequestBody(true)),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("text_delta");
    expect(text).toContain("message_stop");
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const proxy = await createDeepSeekProxy({ port: 0, upstreamBaseUrl: "http://127.0.0.1:1" });
    openServers.push(proxy);
    const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(artifactRequestBody()),
    });
    expect(res.status).toBe(502);
  });
});
