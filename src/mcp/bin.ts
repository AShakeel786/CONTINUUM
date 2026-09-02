#!/usr/bin/env node
/**
 * `continuum-mcp` — the stdio MCP server binary. An agent launches this as a
 * subprocess and speaks JSON-RPC over stdio. Compiles to `dist/mcp/bin.js`.
 *
 * The server inherits the launching CLI's working directory. When that is a
 * registered CONTINUUM project, every MemoryCore recall is scoped to that
 * project's isolated bucket (memory isolation) — outside a project it uses
 * the base identity, which is intended.
 */

import { buildToolRegistry } from "./build.js";
import { runServer } from "./server.js";
import { ProjectRegistry } from "../registry/registry.js";
import { ProjectRegistryStore } from "../registry/store.js";
import { resolveDataDir } from "../config/paths.js";

async function detectProjectScope(): Promise<string | undefined> {
  try {
    const projects = new ProjectRegistry(new ProjectRegistryStore(resolveDataDir()));
    const detected = await projects.detect(process.cwd());
    return detected?.id;
  } catch {
    return undefined; // no registry / not inside a project → base identity
  }
}

const memoryProjectScope = await detectProjectScope();
const registry = await buildToolRegistry(memoryProjectScope ? { memoryProjectScope } : {});
await runServer({ name: "continuum", version: "0.1.0-mcp", registry });
