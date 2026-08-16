# Reversible Context Pruning — Architecture

**Phase:** Token Efficiency Phase 4
**Scope:** reduce long-session prompt growth by pruning stale/low-priority context blocks
*without losing them* — the full block is persisted out-of-band and replaced with a compact,
retrievable reference.

## Architecture

New `src/context/pruning.ts`:

- `PruneStore` interface + `FilePruneStore` (bounded disk under `~/.continuum/pruned-context/`,
  keyed by session; global max entries/bytes with LRU cleanup; `clearSession`).
- `applyReversiblePruning(originalEnvelope, budget, store, sessionKey)` — consumes the
  TokenManager's trim events, persists each eligible pruned block, and replaces it with a
  compact reference block (same class → same section).
- Reference block content: `[pruned <class>] <label> — full content externalized. Retrieve with
  context_retrieve("<refId>")`.

`src/token/budget.ts` now protects `current-task` in addition to `instructions` (never pruned).

`src/mcp/build.ts` registers a read-only `context_retrieve` MCP tool that returns the byte-for-byte
original for a `refId` (itself `cacheScope:"global"` so repeated retrievals are cached).

## Eligibility rules

- **Never pruned:** `instructions` (system constraints) and `current-task` (what the agent is doing now).
- **Prunable (when over budget):** `recalled-memory`, `recent-conversation`, `tool-results`,
  `project-context`, `persona`, `scene-index`, `static-tools`.
- **Fail-closed:** if persistence fails, the original block is kept (never discarded). If retrieval
  fails, the agent gets a clear "not found" error — never a fabricated result.
- **No LLM summarization** by default (deterministic reference; a short label is the first line).

## Retrieval design

- Reference id format: `refId` (SHA-1 of session + block id + content).
- Retrieval: `context_retrieve("<refId>")` returns the full original; byte-for-byte (tested).
- Storage bounded (64 MB / 1000 entries) and tied to session lifecycle via `clearSession`.

## Integration

`launcher-context.ts` wires a `FilePruneStore`; `prepareLaunch` calls `allocateBudget` then
`applyReversiblePruning` and renders the result. Native CLI providers receive whatever context
CONTINUUM assembles (the boundary: CONTINUUM controls the assembled context, not the CLI's own
internal history).

## Telemetry

`PruningTelemetry`: blocks pruned, tokens externalized, active tokens after pruning. The store also
tracks retrieval count and restoration failures.

## Default on/off

**Default on** for the launcher (wired in `launcher-context.ts`); off when no prune store is provided
(test harness).

## Next / remaining question: is structural compression still worth doing?

After reversible pruning, the remaining active prompt is already budget-trimmed. **Structural
compression (headroom-style reversible JSON/whitespace compaction) would be low-value on top of
pruning** for a coding agent, because pruning already removed the low-priority bulk; the marginal
gain is mostly on already-small remaining blocks. Recommend deferring structural compression
indefinitely unless a concrete JSON/log-heavy workload shows otherwise.
