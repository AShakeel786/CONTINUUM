#!/usr/bin/env node
/**
 * `continuum-mcp` — the stdio MCP server binary. An agent launches this as a
 * subprocess and speaks JSON-RPC over stdio. Compiles to `dist/mcp/bin.js`.
 */

import { buildToolRegistry } from "./build.js";
import { runServer } from "./server.js";

const registry = await buildToolRegistry();
await runServer({ name: "continuum", version: "0.1.0-mcp", registry });
