/**
 * Per-turn tool-schema selection for the Direct-API agent loop. The full MCP
 * registry (~1.9k tokens of JSON schema) is sent to the model on every turn
 * today; most of it is never model-driven — session/project bookkeeping is
 * done automatically by the harness, and memory writes happen out of band.
 * Trimming the schema to what a turn can actually use is the single biggest
 * measured reduction in local-model prompt-prefill cost.
 *
 * Categorisation is by well-known tool NAME only — no provider identity, no
 * Ornith special-casing. A tool the harness does not recognise is treated as
 * a task tool (fail-open: never hide a capability the model might need).
 */

import type { ToolDefinition } from "../mcp/tools.js";

/** Real coding surface — always offered on a task turn. */
const CODING = new Set(["exec", "read_file", "write_file", "edit_file", "list_files", "search_files"]);
/** Needed to pull back optimizer-compacted output / pruned context. */
const RETRIEVAL = new Set(["tool_output_retrieve", "context_retrieve"]);
/** The model legitimately drives memory *reads*. */
const MEMORY_READ = new Set(["memory_recall", "memory_search"]);
/**
 * Harness-driven, never needed in the model's schema: session/project
 * bookkeeping is recorded automatically (`recordToolActivity`) and a
 * completed exchange is captured out of band (`onExchange`).
 */
const HARNESS_ONLY = new Set([
  "memory_capture",
  "memory_store_atom",
  "session_state",
  "session_recent",
  "session_update",
  "project_state",
  "project_list",
]);

export type TurnToolIntent = "absent" | "conversational" | "task";

/**
 * The tools to advertise for this turn.
 *   - `absent` / `conversational` → none (a greeting is answered directly).
 *   - `task` → coding + retrieval + memory-read, plus any unrecognised tool.
 */
export function selectToolsForTurn(all: readonly ToolDefinition[], intent: TurnToolIntent): readonly ToolDefinition[] {
  if (intent !== "task") return [];
  return all.filter((t) => {
    if (HARNESS_ONLY.has(t.name)) return false;
    return CODING.has(t.name) || RETRIEVAL.has(t.name) || MEMORY_READ.has(t.name) || !isKnownName(t.name);
  });
}

function isKnownName(name: string): boolean {
  return CODING.has(name) || RETRIEVAL.has(name) || MEMORY_READ.has(name) || HARNESS_ONLY.has(name);
}
