import { describe, expect, it } from "vitest";
import { selectToolsForTurn } from "../tool-selection.js";
import type { ToolDefinition } from "../../mcp/tools.js";

const def = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: "object", properties: {} }, access: "read" });
const all = [
  "memory_recall", "memory_search", "memory_capture", "memory_store_atom",
  "session_state", "session_recent", "session_update", "project_state", "project_list",
  "tool_output_retrieve", "context_retrieve",
  "exec", "read_file", "write_file", "edit_file", "list_files", "search_files",
  "some_future_tool",
].map(def);

describe("selectToolsForTurn", () => {
  it("offers no tools for a conversational / absent turn", () => {
    expect(selectToolsForTurn(all, "conversational")).toEqual([]);
    expect(selectToolsForTurn(all, "absent")).toEqual([]);
  });

  it("a task turn gets the full coding surface + retrieval + memory-read + unknown tools", () => {
    const names = selectToolsForTurn(all, "task").map((t) => t.name);
    for (const n of ["exec", "read_file", "write_file", "edit_file", "list_files", "search_files"]) {
      expect(names).toContain(n);
    }
    expect(names).toContain("tool_output_retrieve");
    expect(names).toContain("context_retrieve");
    expect(names).toContain("memory_recall");
    expect(names).toContain("memory_search");
    expect(names).toContain("some_future_tool"); // fail-open on unknown
  });

  it("a task turn drops harness-driven bookkeeping tools from the model schema", () => {
    const names = selectToolsForTurn(all, "task").map((t) => t.name);
    for (const n of ["memory_capture", "memory_store_atom", "session_state", "session_recent", "session_update", "project_state", "project_list"]) {
      expect(names).not.toContain(n);
    }
  });

  it("materially shrinks the advertised schema", () => {
    expect(selectToolsForTurn(all, "task").length).toBeLessThan(all.length);
  });
});
