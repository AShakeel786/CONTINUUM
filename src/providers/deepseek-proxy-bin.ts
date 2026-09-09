#!/usr/bin/env node
/**
 * Standalone entry point for the DeepSeek schema-sanitizing proxy.
 *
 *   node dist/providers/deepseek-proxy-bin.js [--port 8177] [--upstream https://api.deepseek.com]
 *
 * Prints one readiness line on startup and one activity line per proxied
 * request (method, path, status, sanitized-pattern count — never auth
 * material or bodies). Exits cleanly on SIGINT/SIGTERM.
 */

import { createDeepSeekProxy } from "./deepseek-proxy.js";

function parseArgs(argv: readonly string[]): { port: number; upstream: string } {
  let port = 8177;
  let upstream = "https://api.deepseek.com";
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
    }
  }
  return { port, upstream };
}

const { port, upstream } = parseArgs(process.argv.slice(2));

const server = await createDeepSeekProxy({
  port,
  upstreamBaseUrl: upstream,
  onActivity: ({ method, path, statusCode, patternsChanged }) => {
    const changed = patternsChanged > 0 ? ` (${patternsChanged} pattern(s) sanitized)` : "";
    console.log(`[deepseek-proxy] ${method} ${path} → ${statusCode}${changed}`);
  },
});

console.log(`[deepseek-proxy] listening on http://127.0.0.1:${port} → ${upstream}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
