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
import { buildCodingTools, codingToolsAvailable } from "./coding-tools.js";
import { defaultRawStore } from "../tool-output/store.js";
import { FilePruneStore } from "../context/pruning.js";

const defaultPruneStore = new FilePruneStore();
import { ProjectRegistry } from "../registry/registry.js";
import { ProjectRegistryStore } from "../registry/store.js";
import { SessionManager } from "../session/manager.js";
import { FileSessionStore } from "../session/store.js";
import { resolveDataDir } from "../config/paths.js";
import { buildDefaultCredentialManager, resolveMemoryCoreConfig } from "../context/memorycore-config.js";
import type { CredentialManager } from "../auth/credential-manager.js";
import path from "node:path";

export interface BuildRegistryOptions {
  readonly dataDir?: string;
  /** Override the memory provider (tests); defaults to unified config resolution. */
  readonly memoryProvider?: MemoryCoreProvider;
  /** Optional credential manager for the gateway service token; defaults to the native backend. */
  readonly credentialManager?: CredentialManager;
  /**
   * When set, registers the local coding harness (exec/read_file/write_file/
   * edit_file/list_files/search_files) scoped to this project — the Direct-API
   * session's real coding-agent surface. Absent → chat-only: no shell or
   * filesystem tools are registered or advertised.
   */
  readonly coding?: { readonly projectPath: string };
}

/** Assembles the default tool registry. */
export async function buildToolRegistry(opts: BuildRegistryOptions = {}): Promise<ToolRegistry> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const projects = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const sessionManager = new SessionManager(new FileSessionStore(path.join(dataDir, "sessions")));

  const credentialManager = opts.credentialManager ?? (await buildDefaultCredentialManager(dataDir));
  const memoryProvider: MemoryCoreProvider =
    opts.memoryProvider ?? (async () => (await resolveMemoryCoreConfig({ credentialManager })).config);
  const sessionDeps: SessionToolDeps = { sessionManager, projects };

  const registry = new ToolRegistry();
  for (const t of buildMemoryTools(memoryProvider)) registry.register(t);
  for (const t of buildSessionTools(sessionDeps)) registry.register(t);
  for (const t of buildRetrievalTools()) registry.register(t);
  if (opts.coding && codingToolsAvailable(opts.coding.projectPath)) {
    for (const t of buildCodingTools(opts.coding.projectPath)) registry.register(t);
  }
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
