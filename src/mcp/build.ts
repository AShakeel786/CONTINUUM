/**
 * Builds the full MCP tool registry from the production dependency graph —
 * MemoryCore (from env config, so unconfigured = clear degraded errors, not
 * crashes) plus CONTINUUM local session/project state. Injected in tests with
 * fakes; wired here for a real `continuum mcp` server.
 */

import { ToolRegistry, type RegisteredTool } from "./tools.js";
import { textResult } from "./tools.js";
import { buildMemoryTools, type MemoryCoreProvider } from "./memory-tools.js";
import { buildSessionTools, type SessionToolDeps } from "./session-tools.js";
import { defaultRawStore } from "../tool-output/store.js";
import { FilePruneStore } from "../context/pruning.js";

const defaultPruneStore = new FilePruneStore();
import { ProjectRegistry } from "../registry/registry.js";
import { ProjectRegistryStore } from "../registry/store.js";
import { SessionManager } from "../session/manager.js";
import { FileSessionStore } from "../session/store.js";
import { resolveDataDir } from "../config/paths.js";
import type { MemoryCoreGatewayConfig } from "../context/memorycore-client.js";
import path from "node:path";

/** Reads MemoryCore config from env; unset = undefined (degraded, not configured). */
export function memoryCoreFromEnv(): MemoryCoreGatewayConfig | undefined {
  const baseUrl = process.env.CONTINUUM_MEMORY_CORE_URL;
  const token = process.env.CONTINUUM_MEMORY_CORE_TOKEN;
  if (!baseUrl || !token) return undefined;
  return {
    baseUrl,
    serviceToken: { envVar: "CONTINUUM_MEMORY_CORE_TOKEN" },
    serviceId: process.env.CONTINUUM_MEMORY_CORE_SERVICE_ID ?? "default",
    teamId: process.env.CONTINUUM_MEMORY_CORE_TEAM_ID ?? "default",
    userId: process.env.CONTINUUM_MEMORY_CORE_USER_ID ?? "default",
    agentId: process.env.CONTINUUM_MEMORY_CORE_AGENT_ID ?? "default",
    timeoutMs: 3000,
  };
}

export interface BuildRegistryOptions {
  readonly dataDir?: string;
  /** Override the memory provider (tests); defaults to env-config. */
  readonly memoryProvider?: MemoryCoreProvider;
}

/** Assembles the default tool registry. */
export async function buildToolRegistry(opts: BuildRegistryOptions = {}): Promise<ToolRegistry> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const projects = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const sessionManager = new SessionManager(new FileSessionStore(path.join(dataDir, "sessions")));

  const memoryProvider: MemoryCoreProvider = opts.memoryProvider ?? (async () => memoryCoreFromEnv());
  const sessionDeps: SessionToolDeps = { sessionManager, projects };

  const registry = new ToolRegistry();
  for (const t of buildMemoryTools(memoryProvider)) registry.register(t);
  for (const t of buildSessionTools(sessionDeps)) registry.register(t);
  for (const t of buildRetrievalTools()) registry.register(t);
  return registry;
}

/** Raw-output retrieval tools for the Tool Output Optimizer + reversible pruning. */
function buildRetrievalTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: "tool_output_retrieve",
        description: "Retrieve the complete original output previously retained by the tool-output optimizer, addressed by a tool-output://<id> reference.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "The raw-output id (from a tool-output://<id> reference)." } }, required: ["id"], additionalProperties: false },
        access: "read",
        cacheScope: "global",
      },
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        const raw = defaultRawStore.get(id);
        return raw !== undefined ? textResult(raw) : textResult(`tool-output ${id} not found (may have been evicted)`, true);
      },
    },
    {
      definition: {
        name: "context_retrieve",
        description: "Retrieve the full content of a context block that was pruned to save tokens (from a [pruned …] reference), addressed by its reference id.",
        inputSchema: { type: "object", properties: { refId: { type: "string", description: "The pruned-block reference id (from a [pruned …] reference)." } }, required: ["refId"], additionalProperties: false },
        access: "read",
        cacheScope: "global",
      },
      handler: async (args) => {
        const refId = typeof args.refId === "string" ? args.refId : "";
        const content = await defaultPruneStore.get(refId);
        return content !== undefined ? textResult(content) : textResult(`pruned block ${refId} not found (may have been evicted)`, true);
      },
    },
  ];
}
