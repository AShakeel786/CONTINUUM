/**
 * Convert the MCP `ToolDefinition` surface into each protocol's tool schema.
 * Capability-driven (branches on protocol, never on provider id).
 */

import type { ToolDefinition } from "../mcp/tools.js";

/** OpenAI-compatible: [{type:"function", function:{name,description,parameters}}]. */
export function toOpenAiTools(tools: readonly ToolDefinition[]): readonly Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** Anthropic-compatible: [{name, description, input_schema}]. */
export function toAnthropicTools(tools: readonly ToolDefinition[]): readonly Record<string, unknown>[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}
