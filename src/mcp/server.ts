/**
 * MCP server over stdio — reads line-delimited JSON-RPC requests from stdin,
 * dispatches the small subset of MCP methods CONTINUUM implements, and writes
 * one JSON line per response to stdout. Dependency-free; the registry holds
 * the actual tool surface.
 *
 * Isolation and secret-safety are structural, not incidental:
 *   - Tool handlers receive only validated args + injected scoped deps.
 *   - No secret ever appears in a `tools/list` schema or an error string.
 *   - MemoryCore failures return a clear error result, never throw, never crash.
 */

import readline from "node:readline";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  MCP_METHOD_INITIALIZE,
  MCP_METHOD_PING,
  MCP_METHOD_TOOLS_CALL,
  MCP_METHOD_TOOLS_LIST,
  makeError,
  makeResponse,
  parseRequest,
  serializeMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";
import { ToolRegistry } from "./tools.js";

export interface ServerOptions {
  readonly name: string;
  readonly version: string;
  readonly registry: ToolRegistry;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

const PROTOCOL_VERSION = "2024-11-05";

/**
 * The request handler: resolves every method, including async tools/call,
 * against the registry. This is the full dispatch path — used by runServer
 * and directly by tests (so the protocol logic is testable without stdio).
 */
export async function handleRequest(
  req: JsonRpcRequest,
  options: ServerOptions,
): Promise<JsonRpcResponse> {
  const { registry } = options;
  switch (req.method) {
    case MCP_METHOD_INITIALIZE:
      return makeResponse(req.id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: options.name, version: options.version },
      });
    case MCP_METHOD_PING:
      return makeResponse(req.id ?? null, {});
    case MCP_METHOD_TOOLS_LIST:
      return makeResponse(req.id ?? null, { tools: registry.list() });
    case MCP_METHOD_TOOLS_CALL: {
      const params = req.params ?? {};
      const name = typeof params.name === "string" ? params.name : undefined;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!name) return makeError(req.id ?? null, JSONRPC_INVALID_PARAMS, "tools/call requires \"name\"");
      if (!registry.has(name)) return makeError(req.id ?? null, JSONRPC_METHOD_NOT_FOUND, `Unknown tool "${name}"`);
      try {
        const result = await registry.call(name, args);
        return makeResponse(req.id ?? null, result);
      } catch (err) {
        return makeError(req.id ?? null, JSONRPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      }
    }
    // Initialize-notification and other notifications carry no id: respond with nothing.
    default:
      return makeError(req.id ?? null, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

/**
 * Runs the stdio loop: stdin lines → dispatch → stdout lines. Never throws on
 * bad input (a parse error becomes a JSON-RPC error response). Resolves when
 * stdin closes.
 */
export async function runServer(options: ServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = readline.createInterface({ input, terminal: false });

  for await (const line of rl) {
    let request: JsonRpcRequest | undefined;
    try {
      request = parseRequest(line);
    } catch (err) {
      const resp = makeError(null, JSONRPC_PARSE_ERROR, err instanceof Error ? err.message : String(err));
      output.write(serializeMessage(resp));
      continue;
    }
    if (request === undefined) continue;

    let response: JsonRpcResponse;
    try {
      response = await handleRequest(request, options);
    } catch (err) {
      response = makeError(request.id ?? null, JSONRPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
    }
    output.write(serializeMessage(response));
  }
}
