# Phase 8 — MCP Tool Layer: Complete

## Pre-work
- Verified git status, secret-scanned Phase 7.1 (only `proxy-user-key` credential-name literal, no real secrets), committed Phase 7.1 as `e5ccbb9` (explicit files, not pushed).

## What was built (wrap, don't duplicate)

| New module | Role |
|---|---|
| `src/mcp/protocol.ts` | JSON-RPC 2.0 framing + MCP message types (dependency-free) |
| `src/mcp/tools.ts` | Tool registry — name/schema/read-vs-write/handler, compact results |
| `src/mcp/memory-tools.ts` | `memory_recall`, `memory_search` (read); `memory_capture`, `memory_store_atom` (write) — wrapping MemoryCore `/v3/*` |
| `src/context/memorycore-write.ts` | Write client (`/v3/conversation/add`, `/v3/atomic/update`, `/v3/core/write`) — same isolation/header contract as the read client |
| `src/mcp/session-tools.ts` | `session_state`, `session_recent`, `project_state`, `project_list` — wrapping SessionManager/ProjectRegistry/session-list |
| `src/mcp/server.ts` + `bin.ts` | stdio MCP server + `continuum-mcp` binary + `continuum mcp` subcommand |

## Requirements met
- Provider-independent — no provider identity in the tool layer.
- stdio first — line-delimited JSON-RPC, real-subprocess tested.
- Standard MCP — initialize/tools/list/tools/call/ping, protocolVersion 2024-11-05, dependency-free (no SDK needed for the needed subset).
- Clear schemas/errors — JSON Schema per tool; JSON-RPC error codes; unknown-tool → -32601.
- read vs write explicit — `access` field on every tool.
- No secrets via MCP — service token resolved at the boundary into the Authorization header, never in a result/schema/error (tested).
- Isolation — explicit-id scoping; bounded listing summaries (no full-session dump).
- MemoryCore unavailable → clear error (isError "not configured"/"failed"), never a crash.
- Token-conscious — compact JSON, bounded lists.
- No Tencent .ps1 dependency; shares resolveDataDir + MemoryCore env-config with the launcher (no second source of truth).

## Tests — 276 passed (274 + 2 protocol), typecheck clean
Tool discovery (8 tools, read/write split), recall/search/capture/store, session/project context, isolation, invalid input (unknown tool/missing name/unknown id → proper errors), MemoryCore unavailable degrade, no-secret-leakage, cross-platform stdio (real subprocess: framing + parse-error -32700).

## Tencent / MemoryCore
tdai-proxy / -hub / -core all Up (healthy). Zero Tencent-repo changes.

## Risks / documented seams
1. No live non-empty MemoryCore round-trip (unconfigured env in harness; degrade path exercised). Read/write clients reuse the proven /v3/* contract, but a live seeded round-trip remains.
2. "Create new memory" has no direct primitive — atomic/update upserts by id; net-new memory flows through L0 conversation/add → async L1 extraction (memory_capture). Deliberate wrap-vs-invent split.
3. No per-agent capability negotiation — capabilities: { tools: {} } only; the server trusts the configured service token.

## Phase 9 recommendation
Combined live-verification effort — seed a disposable MemoryCore identity and run one integration pass through Phase 4 context harness → Phase 5 handoff → Phase 7 launcher → Phase 8 MCP read/write against real Gateway data, closing the "implemented-but-not-live-verified" caveat that Phases 4/5/7/8 each independently flagged.

## State
- Committed: Phase 6 `8f41186`, Phase 7 `7423da8`, Phase 7.1 `e5ccbb9`.
- Phase 8 uncommitted (working tree): `src/mcp/`, `src/context/memorycore-write.ts`, `src/cli/commands/mcp.ts`, 3 new docs, README.md/package.json/src/cli/index.ts modified.
- Not committed, not pushed. STOP.
