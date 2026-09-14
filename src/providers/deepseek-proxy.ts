/**
 * Local pass-through proxy for Claude Code sessions redirected to DeepSeek's
 * Anthropic-compatible endpoint. It is the provider boundary: Anthropic-format
 * requests arrive from the CLI, tool `input_schema`s are sanitized for
 * DeepSeek's stricter validator (see deepseek-schema-sanitizer.ts), and the
 * request is forwarded verbatim otherwise — headers, body, streaming
 * responses and all. Auth headers are relayed but never logged; bodies are
 * never logged; the activity callback carries only method/path/status/counts.
 *
 * Liveness restoration (Sept 2026): DeepSeek documents SSE `: keep-alive`
 * comment frames while inference is pending and closes the connection after
 * ~10 minutes without inference. Under scheduling pressure its edge has been
 * observed holding event-stream responses completely silent (0 bytes, no
 * documented keep-alives), which lets Claude Code's stream watchdog fire and
 * burn the request through streaming retries into a non-streaming fallback
 * that surfaces a confusing "empty or malformed response (HTTP 200)". The
 * proxy therefore restores the provider's documented liveness signal: when an
 * event-stream response from the upstream is silent for `livenessFrameMs`
 * (default 25s), it writes the same `: keep-alive` comment frame DeepSeek
 * itself documents — never a fabricated Anthropic event. Frames are only
 * injected between complete SSE frames, and only into event-stream responses;
 * every other body is forwarded byte-for-byte.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as httpMod from "node:http";
import * as httpsMod from "node:https";
import * as zlib from "node:zlib";
import { sanitizeToolSchemaForDeepSeek } from "./deepseek-schema-sanitizer.js";

export interface DeepSeekProxyActivity {
  method: string;
  path: string;
  statusCode: number;
  patternsChanged: number;
  /**
   * Safe classification of a small upstream JSON body (top-level keys and
   * error/object `type` values only — never body content). Present only when
   * the upstream answered with a JSON content-type and the body finished
   * within the classification cap.
   */
  bodyShape?: string;
  /** Number of liveness frames injected while the upstream was silent. */
  livenessFrames?: number;
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
  /**
   * Silence window (ms) after which an event-stream response from the
   * upstream gets a liveness frame forwarded to the client — restores
   * DeepSeek's documented `: keep-alive` behavior when its edge goes quiet
   * during a queued request. Default 25_000 (well below Claude Code's stream
   * watchdog). 0 disables injection (the response is still streamed
   * byte-for-byte).
   */
  livenessFrameMs?: number;
  /**
   * Frame emitted during upstream silence. `"comment"` (default) writes the
   * SSE comment `: keep-alive` — the exact artifact DeepSeek documents;
   * `"ping"` writes DeepSeek's own `event: ping` / `data: {}` frame. Neither
   * fabricates an Anthropic message event.
   */
  livenessFrameKind?: "comment" | "ping";
}

const DEFAULT_PORT = 8177;
const DEFAULT_UPSTREAM = "https://api.deepseek.com";
const DEFAULT_LIVENESS_FRAME_MS = 25_000;
/** Bodies larger than this are forwarded unclassified (no buffering). */
const BODY_CLASSIFY_CAP_BYTES = 16 * 1024;

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
  const livenessFrameMs = options.livenessFrameMs ?? DEFAULT_LIVENESS_FRAME_MS;
  const livenessFrameKind = options.livenessFrameKind ?? "comment";

  const server = createServer((req, res) => {
    void handleRequest(req, res, upstream, onActivity, livenessFrameMs, livenessFrameKind);
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
  livenessFrameMs: number,
  livenessFrameKind: "comment" | "ping",
): Promise<void> {
  const method = req.method ?? "GET";
  const reqUrl = req.url ?? "/";

  if (method === "GET" && (reqUrl === "/health" || reqUrl.startsWith("/health?"))) {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.end(JSON.stringify({ ok: true, service: DEEPSEEK_PROXY_SERVICE_ID, upstream }));
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    // A client that aborts mid-upload must not take the proxy down; respond
    // with a diagnosable error when possible and stop.
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(400, { "content-type": "application/json" });
      res.flushHeaders();
      res.end(JSON.stringify({ error: "deepseek-proxy: request body read failed", detail: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
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

  // Client aborts must propagate upstream: Claude Code's own stream watchdog
  // aborts slow streams, and the upstream request must not linger holding a
  // provider slot (or a socket) after the client is gone.
  let upstreamReq: ReturnType<typeof impl.request> | undefined;
  const abortUpstream = () => {
    upstreamReq?.destroy();
  };
  res.on("close", abortUpstream);
  req.on("close", () => {
    // Only when the client goes away before the response finished.
    if (!res.writableEnded) abortUpstream();
  });

  upstreamReq = impl.request(upstreamUrl, { method, headers }, (upstreamRes) => {
    const activity: DeepSeekProxyActivity = { method, path: reqUrl, statusCode: upstreamRes.statusCode ?? 0, patternsChanged };
    onActivity(activity);
    const resHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      resHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);
    // On Windows loopback, response headers can otherwise sit unflushed
    // (Nagle + delayed ACK) until the first body byte arrives — the client
    // must see the upstream's headers (and the stream start) immediately,
    // especially while the upstream is queued and sending nothing yet.
    res.flushHeaders();

    const contentType = String(upstreamRes.headers["content-type"] ?? "");
    const isEventStream = contentType.includes("text/event-stream");
    if (isEventStream && livenessFrameMs > 0) {
      relayEventStreamWithLiveness(upstreamRes, res, activity, onActivity, livenessFrameMs, livenessFrameKind);
      return;
    }
    if (isJsonResponse(contentType)) {
      relayJsonWithClassification(upstreamRes, res, activity, onActivity, String(upstreamRes.headers["content-encoding"] ?? ""));
      return;
    }
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (err) => {
    onActivity({ method, path: reqUrl, statusCode: 502, patternsChanged });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.flushHeaders();
      res.end(JSON.stringify({ error: "deepseek-proxy: upstream unreachable", detail: err.message }));
    } else {
      res.destroy();
    }
  });
  if (outbound.length > 0) upstreamReq.write(outbound);
  upstreamReq.end();
}

/**
 * Forward an event-stream response chunk-by-chunk, and while the upstream is
 * silent (no bytes for `livenessFrameMs`) write the configured liveness frame
 * to the client. Frames are only injected between complete SSE frames (never
 * mid-frame) and are never converted into message events; upstream bytes are
 * otherwise relayed verbatim and in order.
 */
function relayEventStreamWithLiveness(
  upstreamRes: IncomingMessage,
  res: ServerResponse,
  activity: DeepSeekProxyActivity,
  onActivity: (activity: DeepSeekProxyActivity) => void,
  livenessFrameMs: number,
  livenessFrameKind: "comment" | "ping",
): void {
  upstreamRes.setEncoding("utf8");
  const livenessFrame = livenessFrameKind === "ping" ? "event: ping\ndata: {}\n\n" : ": keep-alive\n\n";
  let injected = 0;
  /** Trailing bytes since the last complete SSE frame (`\n\n`). */
  let partial = "";
  let timer: NodeJS.Timeout | null = null;

  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (partial === "" && !res.destroyed && !res.writableEnded) {
        res.write(livenessFrame);
        injected += 1;
      }
      armTimer();
    }, livenessFrameMs);
  };
  armTimer();

  upstreamRes.on("data", (chunk: string) => {
    res.write(chunk);
    partial += chunk;
    const idx = partial.lastIndexOf("\n\n");
    partial = idx === -1 ? partial : partial.slice(idx + 2);
    // Any upstream byte is activity: the silence window restarts.
    armTimer();
  });
  const finish = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  upstreamRes.on("end", () => {
    finish();
    res.end();
    if (injected > 0) onActivity({ ...activity, livenessFrames: injected });
  });
  upstreamRes.on("error", () => {
    finish();
    res.destroy();
  });
}

/**
 * Relay a JSON response byte-for-byte while classifying it safely: bodies up
 * to `BODY_CLASSIFY_CAP_BYTES` are buffered whole and their shape (top-level
 * keys, error/object `type` values — never body content) is reported through
 * the activity callback so a provider 200-that-is-not-a-Message stays
 * diagnosable. Larger bodies stream through unclassified.
 */
function relayJsonWithClassification(
  upstreamRes: IncomingMessage,
  res: ServerResponse,
  activity: DeepSeekProxyActivity,
  onActivity: (activity: DeepSeekProxyActivity) => void,
  contentEncoding: string,
): void {
  const declared = upstreamRes.headers["content-length"];
  const declaredLength = declared === undefined ? undefined : Number(Array.isArray(declared) ? declared[0] : declared);
  if (declaredLength !== undefined && (Number.isNaN(declaredLength) || declaredLength > BODY_CLASSIFY_CAP_BYTES)) {
    upstreamRes.pipe(res);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  upstreamRes.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (tooBig) {
      res.write(chunk);
      return;
    }
    if (size > BODY_CLASSIFY_CAP_BYTES) {
      tooBig = true;
      res.write(Buffer.concat(chunks));
      res.write(chunk);
      return;
    }
    chunks.push(chunk);
  });
  upstreamRes.on("end", () => {
    if (tooBig) {
      res.end();
      return;
    }
    const body = Buffer.concat(chunks);
    let shape: string | undefined;
    try {
      // DeepSeek gzips some small JSON responses; classify the decompressed
      // form (bounded) while the client-facing body stays the exact bytes.
      const effectiveEncoding = contentEncoding.split(",").map((s) => s.trim().toLowerCase()).find((s) => s === "gzip");
      const text = effectiveEncoding ? zlib.gunzipSync(body).toString("utf8") : body.toString("utf8");
      shape = classifyJsonShape(JSON.parse(text));
    } catch {
      shape = "unparseable-json";
    }
    onActivity({ ...activity, bodyShape: shape });
    res.end(body);
  });
  upstreamRes.on("error", () => res.destroy());
}

/** Top-level JSON keys and `type`/`object` enum values only — never body content. */
function classifyJsonShape(json: unknown): string {
  if (json === null || typeof json !== "object") return "json-scalar";
  const obj = json as Record<string, unknown>;
  if (obj["type"] === "message") return "anthropic-message";
  if (typeof obj["error"] === "object" && obj["error"] !== null) {
    const e = obj["error"] as Record<string, unknown>;
    const t = typeof e["type"] === "string" ? e["type"] : typeof e["code"] === "string" ? e["code"] : "unknown";
    return `json-error-type:${t.slice(0, 64)}`;
  }
  if (typeof obj["object"] === "string") return `json-object:${obj["object"].slice(0, 64)}`;
  if (typeof obj["type"] === "string") return `json-type:${obj["type"].slice(0, 64)}`;
  return `json-keys:${Object.keys(obj).slice(0, 5).join(",")}`;
}

function isJsonResponse(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.includes("+json") || contentType.includes("text/json");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
