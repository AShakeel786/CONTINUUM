/**
 * MCP protocol layer — the JSON-RPC 2.0 framing and message types a MCP
 * (Model Context Protocol) server speaks over stdio. Implemented directly on
 * Node's stdio primitives rather than pulling a heavy SDK: the wire contract
 * for the subset CONTINUUM needs (initialize, tools/list, tools/call,
 * ping, notifications) is small, and hand-rolling the framing keeps the
 * dependency graph at zero for a phase whose whole point is "wrap existing
 * systems, add nothing new."
 *
 * Transport: line-delimited JSON over stdin/stdout (the stdio transport MCP
 * specifies). Each message is exactly one JSON object followed by a newline.
 * Stderr is reserved for out-of-band diagnostics and is never part of the
 * protocol stream.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

// ── MCP method constants ────────────────────────────────────────────────

export const MCP_METHOD_INITIALIZE = "initialize";
export const MCP_METHOD_INITIALIZED = "notifications/initialized";
export const MCP_METHOD_TOOLS_LIST = "tools/list";
export const MCP_METHOD_TOOLS_CALL = "tools/call";
export const MCP_METHOD_PING = "ping";

// ── JSON-RPC 2.0 standard error codes ───────────────────────────────────

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export function makeResponse(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ── Framing ─────────────────────────────────────────────────────────────

/**
 * Serialize a response to exactly one line of newline-terminated JSON.
 * Content from tool results must already be serialized (never a raw secret);
 * this is the single place every byte leaves the process on the stdout wire.
 */
export function serializeMessage(msg: JsonRpcResponse): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Parse one line of wire input into a request object. Returns `undefined` for
 * a blank line (keep-alive), and throws a distinguishable error for
 * malformed JSON or a non-JSON-RPC shape (handled by the caller as a parse
 * error, per the JSON-RPC spec).
 */
export function parseRequest(line: string): JsonRpcRequest | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const obj = JSON.parse(trimmed) as unknown;
  if (typeof obj !== "object" || obj === null) throw new Error("request is not a JSON object");
  const req = obj as JsonRpcRequest;
  if (req.jsonrpc !== "2.0") throw new Error("jsonrpc must be \"2.0\"");
  if (typeof req.method !== "string" || req.method.length === 0) throw new Error("method is required");
  return req;
}
