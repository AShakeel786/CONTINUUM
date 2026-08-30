/**
 * Memory tools — the MCP surface over MemoryCore's Gateway, wrapping the
 * existing read client (`memorycore-client.ts`) and write client
 * (`memorycore-write.ts`). Read tools surface persona/scene-index/recalled
 * memory as compact, token-conscious text; write tools are explicitly
 * labeled `write`. MemoryCore unavailability (unconfigured, unreachable, or
 * HTTP/auth failure) yields a clear error result — never a crash.
 */

import { fetchStableFromMemoryCore, fetchDynamicRecallFromMemoryCore, type MemoryCoreGatewayConfig } from "../context/memorycore-client.js";
import { captureTurn, updateAtomicMemory, writeCoreMemory } from "../context/memorycore-write.js";
import { jsonResult, textResult, type RegisteredTool, type ToolResult } from "./tools.js";

/** A provider-independent gateway connection factory — injected so tests can point at a fake and production points at env-config. */
export type MemoryCoreProvider = () => Promise<MemoryCoreGatewayConfig | undefined>;

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

/** Builds the full set of memory tools. */
export function buildMemoryTools(provider: MemoryCoreProvider): RegisteredTool[] {
  return [
    {
      definition: {
        name: "memory_recall",
        description: "Fetch stable memory (L3 persona + L2 scene index) for the current project/agent context. Read-only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        access: "read",
      },
      handler: async () => {
        const cfg = await provider();
        if (!cfg) return textResult("MemoryCore is not configured (set CONTINUUM_MEMORY_CORE_URL/TOKEN). Recall unavailable.", true);
        try {
          const stable = await fetchStableFromMemoryCore(cfg);
          return jsonResult({
            persona: stable.persona?.content ?? null,
            sceneIndex: stable.sceneIndex.map((s) => ({ path: s.path, summary: s.summary ?? null })),
          });
        } catch (err) {
          return textResult(errMessage(err, "MemoryCore recall"), true);
        }
      },
    },
    {
      definition: {
        name: "memory_search",
        description: "Search relevant L1 atomic memories by query. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (max 2048 chars)." },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 5)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        access: "read",
      },
      handler: async (args) => {
        const query = stringArg(args, "query");
        if (!query) return textResult("memory_search requires a non-empty \"query\".", true);
        const cfg = await provider();
        if (!cfg) return textResult("MemoryCore is not configured. Search unavailable.", true);
        try {
          const limit = typeof args.limit === "number" ? args.limit : 5;
          const dynamic = await fetchDynamicRecallFromMemoryCore(cfg, query, limit);
          return jsonResult(dynamic.items.map((i) => ({ id: i.id, type: i.type ?? null, content: i.content, score: i.score ?? null })));
        } catch (err) {
          return textResult(errMessage(err, "MemoryCore search"), true);
        }
      },
    },
    {
      definition: {
        name: "memory_capture",
        description: "Commit a completed conversation turn and trigger the async L0→L1→L2→L3 memory extraction pipeline. Write.",
        inputSchema: {
          type: "object",
          properties: {
            user_content: { type: "string", description: "The user's message in this turn." },
            assistant_content: { type: "string", description: "The assistant's reply in this turn." },
            session_key: { type: "string", description: "Optional session key (defaults to the configured session id)." },
          },
          required: ["user_content", "assistant_content"],
          additionalProperties: false,
        },
        access: "write",
      },
      handler: async (args) => {
        const userContent = stringArg(args, "user_content");
        const assistantContent = stringArg(args, "assistant_content");
        if (!userContent || !assistantContent) {
          return textResult("memory_capture requires \"user_content\" and \"assistant_content\".", true);
        }
        const cfg = await provider();
        if (!cfg) return textResult("MemoryCore is not configured. Capture unavailable.", true);
        try {
          const res = await captureTurn(cfg, {
            userContent,
            assistantContent,
            sessionKey: stringArg(args, "session_key"),
          });
          return jsonResult({
            l0_recorded: res.l0Recorded,
            scheduler_notified: res.schedulerNotified,
          });
        } catch (err) {
          return textResult(errMessage(err, "MemoryCore capture"), true);
        }
      },
    },
    {
      definition: {
        name: "memory_store_atom",
        description: "Store/update a single L1 atomic memory by id. Write.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory atom id to update." },
            content: { type: "string", description: "Memory content (max 8192 chars)." },
            background: { type: "string", description: "Optional background/context note." },
          },
          required: ["id", "content"],
          additionalProperties: false,
        },
        access: "write",
      },
      handler: async (args) => {
        const id = stringArg(args, "id");
        const content = stringArg(args, "content");
        if (!id || !content) return textResult("memory_store_atom requires \"id\" and \"content\".", true);
        const cfg = await provider();
        if (!cfg) return textResult("MemoryCore is not configured. Store unavailable.", true);
        try {
          const res = await updateAtomicMemory(cfg, { id, content, background: stringArg(args, "background") });
          return jsonResult({ updated: res.code === 0, code: res.code });
        } catch (err) {
          return textResult(errMessage(err, "MemoryCore store"), true);
        }
      },
    },
  ];
}

/**
 * Error → safe, actionable tool text. A dead gateway is surfaced with the
 * repair hint, not a bare `fetch failed` (the raw node fetch rejection the
 * observed `memory_recall → fetch failed` was echoing).
 */
function errMessage(err: unknown, operation: string): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg === "fetch failed" || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network error|timeout|aborted/i.test(msg)) {
      return `${operation} failed: MemoryCore gateway unreachable (${msg}) — run \`continuum doctor --repair\` to start the Tencent stack`;
    }
    return `${operation} failed: ${msg}`;
  }
  return `${operation} failed: ${String(err)}`;
}
