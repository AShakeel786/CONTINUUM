/**
 * Tool registry — the provider-independent tool surface. A tool is a name, a
 * JSON Schema for its arguments, an explicit read-vs-write classification
 * (surfaced so a caller can treat writes distinctly), and a handler that maps
 * validated input → a token-conscious result. No provider identity lives here;
 * handlers are pure functions of the injected dependencies (MemoryCore
 * client, session/project modules), so the same registry serves any agent.
 */

export type ToolAccess = "read" | "write";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Open-world JSON Schema describing the tool's arguments (a plain object). */
  readonly inputSchema: Record<string, unknown>;
  readonly access: ToolAccess;
}

export interface ToolResult {
  /** The primary content an agent should read. Kept small/structured, not a blob dump. */
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  /** True when a tool request is syntactically valid but semantically refused (e.g. isolation violation). */
  readonly isError?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`tool "${tool.definition.name}" is already registered`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /** Invoke a tool by name, returning its result. Throws `UnknownToolError` for an unknown name. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name, this.list().map((t) => t.name));
    return tool.handler(args);
  }
}

export class UnknownToolError extends Error {
  readonly name: string;
  readonly known: readonly string[];
  constructor(name: string, known: readonly string[]) {
    super(`Unknown tool "${name}". Known: ${known.join(", ")}`);
    this.name = "UnknownToolError";
    this.known = known;
  }
}

/**
 * A tool-result payload for a single JSON value — wraps structured data in a
 * compact text form so every response is both machine-inspectable and token
 * light (no pretty-printing, no echoed secret fields).
 */
export function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
