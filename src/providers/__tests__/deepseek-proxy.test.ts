import { createServer, type Server, type ServerResponse } from "node:http";
import * as httpMod from "node:http";
import type { AddressInfo } from "node:net";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepSeekProxy, DEEPSEEK_PROXY_SERVICE_ID } from "../deepseek-proxy.js";

const ARTIFACT_PATTERN = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$";
const ARTIFACT_PATTERN_SANITIZED = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./\\[\\]]{1,200}$";

/** Complete Anthropic event sequence used by the SSE mocks. */
function writeFullSequence(res: ServerResponse, prefix = ""): void {
  res.write(prefix);
  res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
  res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
}

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
    expect(await res.json()).toEqual({
      ok: true,
      service: DEEPSEEK_PROXY_SERVICE_ID,
      upstream: `http://127.0.0.1:${portOf(upstream.server)}`,
    });
    expect(upstream.captured).toHaveLength(0);
  });

  it("sanitizes the Artifact tool schema before forwarding; upstream 200 is relayed", async () => {
    const upstream = await startMockUpstream();
    const activities: { statusCode: number; patternsChanged: number; bodyShape?: string }[] = [];
    const proxy = await createDeepSeekProxy({
      port: 0,
      upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
      onActivity: (a) => activities.push({ statusCode: a.statusCode, patternsChanged: a.patternsChanged, bodyShape: a.bodyShape }),
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
    // One entry at response start, and (new) one at response end carrying the
    // safe body-shape classification of the small JSON body.
    expect(activities[0]).toMatchObject({ statusCode: 200, patternsChanged: 1 });
    expect(activities[1]).toMatchObject({ statusCode: 200, patternsChanged: 1, bodyShape: "anthropic-message" });
    expect(activities).toHaveLength(2);
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

  describe("stream liveness (upstream silence)", () => {
    interface SilentUpstream {
      server: Server;
      closedEarly: () => boolean;
    }

    /**
     * SSE mock: 200 + event-stream headers immediately, then `silenceMs` of
     * silence (optionally upstream keep-alive comments, or a deliberately
     * half-written frame) before the full Anthropic event sequence.
     */
    async function startSilentSseUpstream(
      silenceMs: number,
      opts: { mode?: "silent" | "keepalive" | "splitFrame" } = {},
    ): Promise<SilentUpstream> {
      let closedEarly = false;
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.on("close", () => {
            if (!res.writableEnded) closedEarly = true;
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          // Production edges (CloudFront/ELB) flush headers immediately even
          // while the body is pending; mimic that so the proxy's silence
          // window starts when the headers arrive.
          res.flushHeaders();
          if (opts.mode === "keepalive") {
            res.write(": keep-alive\n\n");
            const t = setInterval(() => res.write(": keep-alive\n\n"), 5);
            setTimeout(() => {
              clearInterval(t);
              writeFullSequence(res);
            }, silenceMs);
            return;
          }
          if (opts.mode === "splitFrame") {
            res.write('event: content_block_start\ndata: {"type":"content_blo');
            setTimeout(() => writeFullSequence(res, 'ck_start"}\n\n'), silenceMs);
            return;
          }
          setTimeout(() => writeFullSequence(res), silenceMs);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      openServers.push(server);
      return { server, closedEarly: () => closedEarly };
    }

    async function postStream(proxyPort: number): Promise<Response> {
      return fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifactRequestBody(true)),
      });
    }

    it("injects : keep-alive comment frames while an SSE upstream is silent, then passes the events through", async () => {
      const upstream = await startSilentSseUpstream(60, { mode: "silent" });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        livenessFrameMs: 10,
      });
      openServers.push(proxy);

      const res = await postStream(portOf(proxy));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(": keep-alive");
      // The real events arrive complete and uncorrupted after the silence.
      expect(text).toContain('event: message_start');
      expect(text).toContain('event: content_block_delta');
      expect(text).toContain('event: message_stop');
      expect(text).toContain('"type":"message_start"');
      // No fabricated Anthropic event: the only event: frames are the mock's.
      const eventFrames = [...text.matchAll(/event: (\w+)/g)].map((m) => m[1]);
      expect(eventFrames).toEqual(["message_start", "content_block_delta", "message_stop"]);
    });

    it("supports event: ping liveness frames (DeepSeek's own liveness event)", async () => {
      const upstream = await startSilentSseUpstream(60, { mode: "silent" });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        livenessFrameMs: 10,
        livenessFrameKind: "ping",
      });
      openServers.push(proxy);

      const text = await (await postStream(portOf(proxy))).text();
      expect(text).toContain("event: ping");
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: message_stop");
    });

    it("never injects liveness into JSON (non-event-stream) responses — byte-exact", async () => {
      const upstream = await startMockUpstream();
      upstream.server.removeAllListeners("request");
      const exactBody = '{"id":"m1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}';
      upstream.server.on("request", (req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.flushHeaders();
          setTimeout(() => res.end(exactBody), 60);
        });
      });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        livenessFrameMs: 10,
      });
      openServers.push(proxy);

      const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifactRequestBody()),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(exactBody);
    });

    it("does not inject while the upstream is actively streaming", async () => {
      const upstream = await startMockUpstream();
      upstream.server.removeAllListeners("request");
      upstream.server.on("request", (req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          let i = 0;
          const t = setInterval(() => {
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
            i += 1;
            if (i >= 120) {
              clearInterval(t);
              writeFullSequence(res);
            }
          }, 5);
        });
      });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        // Any 300ms event-loop stall during a 5ms-cadence stream would be an
        // environment failure, not a proxy one — the margin makes the
        // reset-on-data behavior the only thing this test can observe.
        livenessFrameMs: 300,
      });
      openServers.push(proxy);

      const text = await (await postStream(portOf(proxy))).text();
      expect(text).not.toContain(": keep-alive");
      expect(text).toContain("event: message_stop");
    });

    it("passes upstream-originated : keep-alive comments through untouched when injection is disabled", async () => {
      const upstream = await startSilentSseUpstream(50, { mode: "keepalive" });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        livenessFrameMs: 0,
      });
      openServers.push(proxy);

      const text = await (await postStream(portOf(proxy))).text();
      expect(text).toContain(": keep-alive");
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: message_stop");
    });

    it("never splits an upstream SSE frame with an injected frame", async () => {
      const upstream = await startSilentSseUpstream(60, { mode: "splitFrame" });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        livenessFrameMs: 10,
      });
      openServers.push(proxy);

      const text = await (await postStream(portOf(proxy))).text();
      // The half-written frame arrives intact — an injected frame inside it
      // would have corrupted this contiguous data line.
      expect(text).toContain('data: {"type":"content_block_start"}');
      expect(text).toContain("event: message_start");
      expect(text).toContain("event: message_stop");
    });

    it("holds the connection open on a truly silent upstream — no fabricated completion, no premature close", async () => {
      const upstream = await startSilentSseUpstream(120, { mode: "silent" });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        livenessFrameMs: 0,
      });
      openServers.push(proxy);

      const started = Date.now();
      const res = await postStream(portOf(proxy));
      expect(res.status).toBe(200);
      const text = await res.text();
      const elapsed = Date.now() - started;
      // The stream was silent for 120ms and must not have ended early.
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(text).toContain("event: message_stop");
      // Nothing was fabricated while upstream was silent.
      expect(text).not.toContain(": keep-alive");
    });

    it("destroys the upstream request when the client aborts mid-stream", async () => {
      const upstream = await startSilentSseUpstream(500, { mode: "silent" });
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        livenessFrameMs: 0,
      });
      openServers.push(proxy);

      const controller = new AbortController();
      const clientFetch = fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifactRequestBody(true)),
        signal: controller.signal,
      });
      const started = Date.now();
      setTimeout(() => controller.abort(), 40);
      await clientFetch.then(() => {}).catch(() => {});
      // Poll briefly: the abort must propagate to the upstream socket.
      while (!upstream.closedEarly() && Date.now() - started < 1000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(upstream.closedEarly()).toBe(true);
    });
  });

  describe("non-stream body classification", () => {
    function jsonUpstream(statusCode: number, body: string): Promise<{ server: Server }> {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(statusCode, { "content-type": "application/json" });
          res.end(body);
        });
      });
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          openServers.push(server);
          resolve({ server });
        });
      });
    }

    it("relays valid Anthropic Message JSON byte-exact", async () => {
      const exactBody = '{"id":"m1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}';
      const upstream = await jsonUpstream(200, exactBody);
      const proxy = await createDeepSeekProxy({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}` });
      openServers.push(proxy);
      const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifactRequestBody()),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(exactBody);
    });

    it("relays HTTP 200 JSON that is NOT an Anthropic Message verbatim and classifies it safely", async () => {
      const exactBody = '{"error":{"type":"server_error","message":"Server busy, please try again later"}}';
      const upstream = await jsonUpstream(200, exactBody);
      const activities: Record<string, unknown>[] = [];
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        onActivity: (a) => activities.push({ ...a }),
      });
      openServers.push(proxy);
      const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifactRequestBody()),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(exactBody);
      // Diagnosable, but the error message text itself is never logged.
      const shape = activities.find((a) => a.bodyShape !== undefined);
      expect(shape?.bodyShape).toBe("json-error-type:server_error");
      expect(JSON.stringify(activities)).not.toContain("Server busy");
    });

    it("relays error statuses and bodies verbatim and diagnosably", async () => {
      const exactBody = '{"error":{"type":"rate_limit_error","message":"429 too many"}}';
      const upstream = await jsonUpstream(429, exactBody);
      const activities: Record<string, unknown>[] = [];
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        onActivity: (a) => activities.push({ ...a }),
      });
      openServers.push(proxy);
      const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifactRequestBody()),
      });
      expect(res.status).toBe(429);
      expect(await res.text()).toBe(exactBody);
      const shape = activities.find((a) => a.bodyShape !== undefined);
      expect(shape?.bodyShape).toBe("json-error-type:rate_limit_error");
    });

    it("classifies gzip-encoded JSON responses while relaying the exact raw bytes", async () => {
      const exactBody = '{"id":"m1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}';
      const gzipped = zlib.gzipSync(exactBody);
      const activities: Record<string, unknown>[] = [];
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
          res.end(gzipped);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      openServers.push(server);
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        onActivity: (a) => activities.push({ ...a }),
      });
      openServers.push(proxy);
      // Raw http client (fetch would transparently decompress the body).
      const wire = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const r = httpMod.request({ host: "127.0.0.1", port: portOf(proxy), path: "/anthropic/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        });
        r.on("error", reject);
        r.end(JSON.stringify(artifactRequestBody()));
      });
      expect(wire.status).toBe(200);
      // Raw gzip bytes relayed untouched (the client decompresses).
      expect(wire.body.equals(gzipped)).toBe(true);
      const shape = activities.find((a) => a.bodyShape !== undefined);
      expect(shape?.bodyShape).toBe("anthropic-message");
    });

    it("streams large JSON bodies through without buffering or classification", async () => {
      const largeBody = `{"type":"message","content":[{"type":"text","text":"${"x".repeat(20 * 1024)}"}]}`;
      const upstream = await jsonUpstream(200, largeBody);
      const activities: Record<string, unknown>[] = [];
      const proxy = await createDeepSeekProxy({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${portOf(upstream.server)}`,
        onActivity: (a) => activities.push({ ...a }),
      });
      openServers.push(proxy);
      const res = await fetch(`http://127.0.0.1:${portOf(proxy)}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifactRequestBody()),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(largeBody);
      expect(activities.every((a) => a.bodyShape === undefined)).toBe(true);
    });
  });
});
