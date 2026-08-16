# Phase 8 — Verification

What Phase 8 built, and how each part was proven.

## Test coverage (276 total: 274 + 2 protocol)

| Module | Tests | What they prove |
|---|---|---|
| `protocol` | 4 | single-line serialization; request parse; blank/malformed handling; method-not-found error |
| `server` (dispatch) | 7 | initialize serverInfo (no secret field); tools/list read-vs-write classification; ping; unknown-tool error; missing-name error; MemoryCore-unavailable degrade; no token leak |
| `server` (session/project) | 3 | scoped session summary; unknown-id `isError`; project_list carries no credential field |
| `stdio` (real subprocess) | 2 | line-delimited JSON-RPC over stdio against MemoryCore-unset (degrade); parse-error returns `-32700` without crash |

## Brief item-by-item

| Requirement | Result |
|---|---|
| Provider-independent MCP server | ✅ no provider identity in the tool layer (registry + handlers are data-driven) |
| Minimal MCP over existing APIs (wrap, don't duplicate) | ✅ every tool wraps `memorycore-client`/`session`/`registry`/`session-list` |
| memory recall/search tools | ✅ `memory_recall`, `memory_search` |
| memory capture/store tools | ✅ `memory_capture` (L0), `memory_store_atom` (L1) |
| session/task state tool | ✅ `session_state` |
| project/session context | ✅ `project_state`, `project_list`, `session_recent` |
| relevant handoff/session info | ✅ `session_state` returns `lastHandoff` from/to |
| standard MCP protocol/SDK where appropriate | ✅ JSON-RPC 2.0 stdio (`initialize`/`tools/*`/`ping`), dependency-free |
| stdio transport first | ✅ |
| clear schemas/errors | ✅ JSON Schema per tool + JSON-RPC error codes |
| read vs write explicit | ✅ `access: read\|write` on every tool |
| no secrets via MCP | ✅ token/secret asserted absent from all responses |
| project/session isolation | ✅ explicit-id scoping, bounded listing summaries |
| MemoryCore unavailable → clear errors/no crash | ✅ `isError` "not configured"/"failed" |
| token-conscious responses | ✅ compact JSON, bounded lists |
| no legacy Tencent launcher dependency | ✅ none referenced |
| standard MCP protocol/SDK where appropriate | ✅ |
| MCP wired into launch/runtime safely | ✅ shared `resolveDataDir` + MemoryCore env-config; spawn path untouched |

## What was NOT verified (documented, not hidden)

- **Live MemoryCore recall/capture** against the real Gateway was not performed
  (unconfigured env in the test harness; the degrade path is exercised). The
  read/write clients hit the same `/v3/*` contract already proven in Phase 4's
  harness, but a live non-empty round-trip remains an integration follow-up
  (same boundary Phases 4/5/7 flagged).
- **`memory_store_atom` `id` semantics** — L1 `atomic/update` upserts *by id*;
  "capture new memory" is the L0 `conversation/add` path (`memory_capture`).
  No tool invents ids; `memory_store_atom` requires an existing id. This is
  the correct wrap-vs-invent split, but worth noting a bare "create memory"
  needs the conversation-add (L0→L1 extraction) path, which is exposed.

## CLI / stdio smoke test

```
$ printf 'init\ntools/list\nping' | node dist/mcp/bin.js
# → initialize (serverInfo/capabilities), tools/list (8 tools w/ access), ping {}
```

Real subprocess test confirms: line-delimited framing, MemoryCore-unset
degrade to `isError`, parse-error → `-32700` (no crash).

## Tencent / MemoryCore health

`tdai-proxy` / `-hub` / `-core` all **Up (healthy)** throughout. Zero
Tencent-repo changes.
