#!/usr/bin/env node
/**
 * Standalone entry point for the DeepSeek schema-sanitizing proxy.
 *
 *   node dist/providers/deepseek-proxy-bin.js [--port 8177] [--upstream https://api.deepseek.com]
 *                                            [--keep-alive-ms 25000] [--keep-alive-kind comment|ping]
 *
 * Prints one readiness line on startup and one activity line per proxied
 * request (method, path, status, sanitized-pattern count, body shape for
 * small JSON responses, and injected liveness-frame count — never auth
 * material or bodies). Exits cleanly on SIGINT/SIGTERM.
 */

import { createDeepSeekProxy } from "./deepseek-proxy.js";

function parseArgs(argv: readonly string[]): { port: number; upstream: string; keepAliveMs: number; keepAliveKind: "comment" | "ping" } {
  let port = 8177;
  let upstream = "https://api.deepseek.com";
  let keepAliveMs = 25_000;
  let keepAliveKind: "comment" | "ping" = "comment";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      const parsed = Number(next);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
      i++;
    } else if (arg === "--upstream" && next) {
      upstream = next;
      i++;
    } else if (arg === "--keep-alive-ms" && next) {
      const parsed = Number(next);
      if (Number.isInteger(parsed) && parsed >= 0) keepAliveMs = parsed;
      i++;
    } else if (arg === "--keep-alive-kind" && next) {
      if (next === "comment" || next === "ping") keepAliveKind = next;
      i++;
    }
  }
  return { port, upstream, keepAliveMs, keepAliveKind };
}

const { port, upstream, keepAliveMs, keepAliveKind } = parseArgs(process.argv.slice(2));

// A graceful, one-line failure when the port is already taken (e.g. a racing
// second launcher lost the bind): exit non-zero instead of an unhandled
// rejection. The winner keeps serving; callers poll /health and only need
// one healthy instance.
let server;
try {
  server = await createDeepSeekProxy({
    port,
    upstreamBaseUrl: upstream,
    livenessFrameMs: keepAliveMs,
    livenessFrameKind: keepAliveKind,
    onActivity: ({ method, path, statusCode, patternsChanged, bodyShape, livenessFrames }) => {
      const parts: string[] = [`[deepseek-proxy] ${method} ${path} → ${statusCode}`];
      if (patternsChanged > 0) parts.push(`${patternsChanged} pattern(s) sanitized`);
      if (bodyShape !== undefined) parts.push(`body=${bodyShape}`);
      if (livenessFrames !== undefined) parts.push(`${livenessFrames} liveness frame(s) injected`);
      console.log(parts.join(" | "));
    },
  });
} catch (err) {
  console.error(`[deepseek-proxy] failed to start on http://127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log(`[deepseek-proxy] listening on http://127.0.0.1:${port} → ${upstream} (liveness: ${keepAliveMs === 0 ? "off" : `${keepAliveMs}ms ${keepAliveKind}`})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
