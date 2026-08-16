# Repo Intelligence Map — Architecture

**Phase:** Token Efficiency Phase 2
**Scope:** reduce repeated codebase discovery/read tokens via a token-budgeted, task-relevant
repository map injected as a `project-context` block. Independently implemented (regex/ctags-style
local parsing; no tree-sitter, no upstream code).

## Architecture

New module `src/repo-map/repo-map.ts`:

- `scanProject(root, opts)` — bounded walk (max files/depth, skips `node_modules`/`.git`/`dist`/
  `build`/etc.), extracts top-level symbols (exports, classes, functions, types) and relative imports
  for `.ts/.tsx/.js/.jsx/.mjs/.cjs` and `.py`. Per-language regex; no external parser dependency.
- `renderMap(index, query, budgetTokens)` — ranks files by query-term relevance (path + symbol names)
  plus structural importance (entry files, core dirs, exported symbols; tests excluded by default),
  then emits a compact `path: symbols…` text bounded by the token budget (using `estimateTokens`).
- `FileRepoMapCache` — disk cache under `~/.continuum/repo-map/`, keyed by a fingerprint of
  `(HEAD sha, dirty flag, newest indexed-file mtime)`.
- `repoMapBlock(result, query)` — a `project-context` `ContextBlock`.

## Integration

`launcher-context.ts` wires `repoMapBuilder` into the launcher; `prepareLaunch` builds the map
best-effort and pushes the block into `callerBlocks` before `buildContextEnvelope` (so it lands in the
stable section, trimmed by the existing TokenManager budget if needed). A build failure never blocks launch.

## Ranking & invalidation

- **Ranking:** query terms (split, ≥3 chars) matched against file path and symbol names, weighted
  higher for path matches; structural boosts for entry files (`index`/`main`/`cli`/`server`/`app`) and
  core dirs (`src/auth`, `src/launcher`, `src/session`, `src/handoff`, `src/providers`, `src/context`);
  exports and non-empty files get a small boost; `__tests__`/`.test.`/`.spec.` excluded by default.
- **Invalidation:** cache key = `HEAD sha : dirty : newest mtime`; any commit, worktree change, or file
  touch changes the key and triggers a rebuild. Unchanged repos reuse the cached map (~30–50 ms warm vs
  ~240 ms cold for CONTINUUM).

## Safety / degradation

- Cross-platform (Node `fs` + `git` via `execFile`; `git` absent → `nogit` fingerprint, still works).
- If parsing/indexing is unavailable or the dir has no source files → `built: false`, no block injected.
- The map is navigation/context only — it never replaces real file reads and contains no file *contents*.

## Default on/off

**Default on** for the launcher (wired in `buildLauncherContext`), budgeted to 1200 tokens. It is
effectively off for tests (the test harness constructs `LauncherDeps` without `repoMapBuilder`).

## Next recommendation

Deterministic Tool Result Cache (order #3 in `INTEGRATION_PLAN.md`).
