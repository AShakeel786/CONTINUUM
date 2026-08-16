/**
 * `continuum mcp` — run the CONTINUUM MCP server over stdio. Thin wrapper
 * around `buildToolRegistry` + `runServer`; an agent launches this subprocess
 * and speaks JSON-RPC. Blocks until stdin closes.
 */

import { buildToolRegistry } from "../../mcp/build.js";
import { runServer } from "../../mcp/server.js";
import type { CliIo } from "../index.js";

export async function runMcpCommand(args: readonly string[], io: CliIo): Promise<number> {
  // MCP communicates on stdout as JSON-RPC; do NOT write human text to stdout.
  // Any diagnostics go to stderr.
  const registry = await buildToolRegistry();
  await runServer({ name: "continuum", version: "0.1.0", registry });
  return 0;
}
