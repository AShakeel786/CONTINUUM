/**
 * Local pass-through proxy for Claude Code sessions redirected to DeepSeek's
 * Anthropic-compatible endpoint. It is the provider boundary: Anthropic-format
 * requests arrive from the CLI, tool `input_schema`s are sanitized for
 * DeepSeek's stricter validator (see deepseek-schema-sanitizer.ts), and the
 * request is forwarded verbatim otherwise — headers, body, streaming
 * responses and all. Auth headers are relayed but never logged; bodies are
 * never logged; the activity callback carries only method/path/status/counts.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as httpMod from "node:http";
import * as httpsMod from "node:https";
import { sanitizeToolSchemaForDeepSeek } from "./deepseek-schema-sanitizer.js";

export interface DeepSeekProxyActivity {
  method: string;
  path: string;
  statusCode: number;
  patternsChanged: number;
}

export interface DeepSeekProxyOptions {
  /** Bind host, default "127.0.0.1" (never exposed beyond localhost). */
  host?: string;
  /** Bind port, default 8177. */
  port?: number;
  /**
   * Upstream origin. The full request path+query is appended (so the CLI's
   * base `.../anthropic` mount point keeps working when the local base is
   * `http://127.0.0.1:<port>/anthropic`). Default "https://api.deepseek.com".
   */
  upstreamBaseUrl?: string;
  /** Observation seam (logging/tests). Receives no auth material. */
  onActivity?: (activity: DeepSeekProxyActivity) => void;
}

const DEFAULT_PORT = 8177;
const DEFAULT_UPSTREAM = "https://api.deepseek.com";

/**
 * Identity marker reported by `/health` and verified by callers before they
 * reuse (or trust) a listener on the proxy port. Guards against an unrelated
 * local service squatting the port and receiving Claude Code traffic —
 * including its auth headers.
 */
export const DEEPSEEK_PROXY_SERVICE_ID = "continuum-deepseek-proxy";

// Hop-by-hop / connection-scoped headers that must not be forwarded verbatim.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "te",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
]);
const STRIPPED_RESPONSE_HEADERS = new Set(["connection", "content-length", "transfer-encoding", "keep-alive"]);

/** Starts the proxy and resolves once it is listening (address() is valid). */
export async function createDeepSeekProxy(options: DeepSeekProxyOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const upstream = (options.upstreamBaseUrl ?? DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const onActivity = options.onActivity ?? (() => {});

  const server = createServer((req, res) => {
    void handleRequest(req, res, upstream, onActivity);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: string,
  onActivity: (activity: DeepSeekProxyActivity) => void,
): Promise<void> {
  const method = req.method ?? "GET";
  const reqUrl = req.url ?? "/";

  if (method === "GET" && (reqUrl === "/health" || reqUrl.startsWith("/health?"))) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: DEEPSEEK_PROXY_SERVICE_ID, upstream }));
    return;
  }

  const raw = await readBody(req);
  let outbound = raw;
  let patternsChanged = 0;

  // Sanitize tool schemas on any message-shaped body carrying `tools`.
  if (raw.length > 0 && reqUrl.includes("/messages")) {
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (parsed !== null && typeof parsed === "object" && "tools" in parsed && Array.isArray((parsed as { tools?: unknown }).tools)) {
        const body = parsed as Record<string, unknown>;
        body.tools = (body.tools as Record<string, unknown>[]).map((tool) => {
          if (!tool || typeof tool !== "object" || !("input_schema" in tool)) return tool;
          const result = sanitizeToolSchemaForDeepSeek(tool.input_schema);
          patternsChanged += result.changedPatterns.length;
          return { ...tool, input_schema: result.schema };
        });
        outbound = Buffer.from(JSON.stringify(body), "utf8");
      }
    } catch {
      // Not JSON — forward the body untouched rather than failing the request.
    }
  }

  const upstreamUrl = `${upstream}${reqUrl}`;
  const impl = upstreamUrl.startsWith("https:") ? httpsMod : httpMod;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (outbound.length !== raw.length) headers["content-length"] = String(outbound.length);

  const upstreamReq = impl.request(upstreamUrl, { method, headers }, (upstreamRes) => {
    onActivity({ method, path: reqUrl, statusCode: upstreamRes.statusCode ?? 0, patternsChanged });
    const resHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      resHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (err) => {
    onActivity({ method, path: reqUrl, statusCode: 502, patternsChanged });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "deepseek-proxy: upstream unreachable", detail: err.message }));
    } else {
      res.destroy();
    }
  });
  if (outbound.length > 0) upstreamReq.write(outbound);
  upstreamReq.end();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
