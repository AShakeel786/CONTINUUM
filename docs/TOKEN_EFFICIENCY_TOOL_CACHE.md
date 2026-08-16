# Deterministic Tool Result Cache — Architecture

**Phase:** Token Efficiency Phase 3
**Scope:** avoid re-running and re-feeding identical read-only deterministic tool results, in the
API agent loop only (native CLI tool execution is inside the CLIs and is untouched).

## Architecture

New module `src/tool-cache/`:

- `tool-cache.ts` — `ToolResultCache` (bounded in-memory LRU + TTL, optional write-through disk
  persistence under `~/.continuum/tool-cache/`), `computeCacheKey` (SHA-1 of tool name + canonical
  args + scope + fingerprint), `canonicalArgs` (order-independent JSON), `ToolScopeProvider` +
  `CacheTelemetry` (hits/misses/evictions/invalidations/tokens-avoided).
- `scope.ts` — `makeScopeProvider` (project fingerprint = git HEAD + dirty; session fingerprint =
  session `revision:updatedAt`), plus `noopScopeProvider`.
- `ToolDefinition.cacheScope` (`"project" | "session" | "global"`) marks cache eligibility.

## Cache eligibility (fail-safe)

| Tool | cacheScope | Key |
|---|---|---|
| `project_state`, `project_list` | `project` | name + args + repo HEAD/dirty |
| `session_state` | `session` | name + args + session `revision:updatedAt` |
| `tool_output_retrieve` | `global` | name + args only |
| `session_recent`, `memory_search`, `memory_recall`, all write tools | *(none)* | never cached |

- Write tools always execute; mutable memory tools are never cached (not proven safe).
- `session_recent` is deliberately uncached: it depends on the whole session store (ambiguous scope).
- **Uncertainty = miss:** if the scope fingerprint can't be computed (no git, missing session, unknown
  scope), the key is `undefined` and the tool always executes — never a stale hit.

## Integration

`launch.ts` constructs a `ToolResultCache` (disk dir `~/.continuum/tool-cache/`) + a
`makeScopeProvider`, passes them to `runApiAgent` → `runAgentLoop`, which resolves each tool call
through `resolveToolText` (check cache → hit or execute+optimize+store). Only the API agent path
uses the cache; native CLI launch is unchanged.

## Fidelity / correctness

- A hit returns the byte-identical optimized text (including the Tool Output Optimizer's raw-output
  reference) that a miss would have produced — the cached entry stores the *final* text.
- Zero stale hits in invalidation tests: repo HEAD/dirty change, session revision change, or an
  uncomputable fingerprint all force a miss.
- Write tools always execute (tested); uncached mutable tools always execute (tested).

## Telemetry

`CacheTelemetry` records hits, misses, evictions, invalidations, and estimated tokens avoided
(`tokensSaved` of each cached entry summed on hits).

## Limitations

- Cache is most valuable within a single agent run; cross-run hits require an unchanged scope
  fingerprint (same HEAD/dirty or same session revision), which is the safe behavior.
- Scope is coarse (whole-repo HEAD/dirty) — per-file fingerprints are a future refinement for
  file-reading tools.

## Default on/off

**Default on** for the API agent path (wired in `launch.ts`); off elsewhere (the test harness and
MCP server are unaffected).

## Next recommendation

Reversible Context Pruning (order #4 in `INTEGRATION_PLAN.md`).
