# Phase 8 — MCP Tool Layer Architecture

Phase 8 builds a provider-independent MCP (Model Context Protocol) server so
any supported agent can reach CONTINUUM/Tencent capabilities through one
standard tool interface — by *wrapping* the systems Phases 3–7 already built,
never duplicating them.

## Design principle: wrap, don't duplicate

Every MCP tool is a thin handler over an existing module:

| MCP tool | Wraps | Kind |
|---|---|---|
| `memory_recall` | `src/context/memorycore-client.ts` (`/v3/core/read` + `/v3/scenario/ls`) | read |
| `memory_search` | `src/context/memorycore-client.ts` (`/v3/atomic/search`) | read |
| `memory_capture` | `src/context/memorycore-write.ts` (`/v3/conversation/add`) | write |
| `memory_store_atom` | `src/context/memorycore-write.ts` (`/v3/atomic/update`) | write |
| `session_state` | `src/session/manager.ts` | read |
| `session_recent` | `src/launcher/session-list.ts` | read |
| `project_state` | `src/registry/registry.ts` | read |
| `project_list` | `src/registry/registry.ts` | read |

The write client (`memorycore-write.ts`) is the one genuinely new transport
piece, and it reuses the exact `/v3/*` header/isolation contract of the
existing read client rather than inventing a new wire shape.

## Protocol — dependency-free JSON-RPC over stdio

Rather than pulling an MCP SDK, the protocol subset CONTINUUM needs is
implemented directly (`src/mcp/protocol.ts`): line-delimited JSON-RPC 2.0 on
stdin/stdout, stderr reserved for diagnostics. Methods:

- `initialize` → serverInfo + `capabilities: { tools: {} }`
- `tools/list` → tool definitions (name, description, JSON Schema, `access`)
- `tools/call` → dispatch to a handler → structured result
- `ping`

This keeps the dependency graph at zero for a phase whose whole point is "add
a standard interface, not new infrastructure," and the framing is trivially
portable (any MCP client can connect to the `continuum-mcp` subprocess).

## Read vs write, explicit

Every `ToolDefinition.access` is `"read"` or `"write"`, surfaced in
`tools/list` so a caller can treat mutating tools distinctly. Memory read tools
are read-only Gateway fetches; `memory_capture`/`memory_store_atom` are the
only write primitives, matching the Gateway's own read/write verb split.

## Isolation & secret safety

- **No secret leaves the process.** `serviceToken` is resolved at the boundary
  into the `Authorization` header inside the MemoryCore client, never returned
  through a tool result, schema, or error. Tests assert responses contain no
  credential/token/secret field.
- **Project/session isolation.** `session_state`/`project_state` resolve an
  *explicit* id and return only that scope's summary. `session_recent` returns
  bounded summaries (id/project/provider/status/goal prefix), never full
  session bodies. There is no "enumerate everything's contents" tool.
- **MemoryCore unavailability** yields a clear `isError` result ("not
  configured" / "fetch failed"), never a thrown exception, never a crash.

## Token-conscious responses

Tool results are compact JSON (or short text), not prose dumps. `session_state`
returns bounded work/decision/file *lists*; `memory_search` returns a bounded
hit list; nothing echoes raw conversation history blindly.

## Wiring into the launcher

The MCP server is a standalone `continuum mcp` / `continuum-mcp` subprocess
(stdio). It shares the same `resolveDataDir` (config, projects, sessions) and
the same MemoryCore env-config (`CONTINUUM_MEMORY_CORE_*`) as the launcher,
so the two surfaces read identical local state and memory — no second source of
truth. No provider CLI redesign: the launcher's spawn path is untouched.

## Cross-platform

stdio transport is inherently platform-neutral; the server has no `.ps1`,
Windows-only path, or host-specific assumption beyond Node's own stdio. The
real-subprocess test exercises the exact line-delimited JSON-RPC framing a
host agent would speak.
