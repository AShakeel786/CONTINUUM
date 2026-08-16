# Tool Output Optimizer — Architecture & Fidelity

**Phase:** Token Efficiency Phase 1
**Scope:** reduce tokens consumed by tool results before they enter model context, losslessly,
with raw output retained + retrievable. LLM-free, deterministic, provider-independent.

## Architecture

New module `src/tool-output/`:

- `types.ts` — `OptimizedToolOutput`, `OptimizerTelemetry`, `OptimizeOptions`.
- `optimizers.ts` — pure, deterministic content optimizers (one function each).
- `optimizer.ts` — dispatcher + telemetry (`optimizeToolOutput`) and `telemetryLine`.
- `store.ts` — `FileRawOutputStore` (bounded in-memory LRU + disk under `~/.continuum/tool-output/`).

## Interception point

In the API agent loop (`src/api-agent/agent.ts`), after each MCP tool result is produced and
before it is appended to the conversation as a `tool` message. `run.ts` wires the optimizer in
by default (overridable for tests). The MCP server itself is untouched.

> Native CLI (Claude/Codex) tool output is produced *inside* those CLIs and is not interceptable
> by CONTINUUM today; documented as a known limitation (CLI providers already self-compress).

## Optimization strategies (deterministic, lossless-first)

| Optimizer | Trigger | What it does | Preserves |
|---|---|---|---|
| `json` | content is JSON | minifies (removes whitespace) | all data |
| `test-runner` | PASS/FAIL/✓/✗ lines | collapses PASS lines, keeps FAIL + stack + summary | failures, expectations, counts |
| `compiler` | `path.ext:line[:col] error/warning` | keeps diagnostics + final summary, drops compile noise | file/line/col, message |
| `git-status` | `Changes`/`Untracked files`/`On branch` | collapses to branch + header + file list | all filenames |
| `git-log` | `commit <sha>` | collapses to `sha subject` per commit | sha + subject |
| `git-diff` | `diff --git` | keeps hunks + stat, drops unchanged context | changed lines |
| `file-listing` | `ls`/`find` shape | keeps filenames, drops metadata columns | filenames |
| `log-dedup` | high duplicate-line ratio | collapses identical non-error lines to `(×N)` | unique lines + all error/warning lines |
| `repeated-lines` | identical adjacent lines | collapses runs to `(×N)` | all distinct content |
| `truncate` | very large output | head + tail + omission note | head/tail + raw ref |

No optimizer invents a "success" or drops errors/warnings/stack traces/filenames/line numbers/
exit codes/summaries/changed values.

## Raw-output retention

- Every optimized result stores the complete original in `FileRawOutputStore` and returns a
  `tool-output://<id>` reference appended to the optimized text.
- Retrieval: the registered MCP tool `tool_output_retrieve` (read-only) returns the byte-for-byte
  original given the id.
- Bounded: max 500 entries / 32 MB total; oldest evicted; stored under `~/.continuum/tool-output/`
  (never in the project tree → cannot become a committed artifact).
- "If safe optimization cannot be proven, return original unchanged" — the dispatcher returns
  `passthrough` (no raw retention) when no optimizer reduces the text or the output is below `minBytes`.

## Fidelity results

- Fidelity tests confirm: FAIL + expectations survive test-runner collapse; `file:line:col` diagnostics
  survive compiler collapse; all filenames survive git-status collapse; an error buried in 200
  repetitive INFO log lines survives `log-dedup`; JSON minification is byte-equivalent (re-parse).
- Raw retrieval is byte-for-byte (tested).

## Telemetry

Per result: original/optimized bytes, original/optimized tokens (via existing `estimateTokens`),
tokens saved, percent saved, optimizer used, raw-retained flag.

## Limitations

- Native CLI tool output is not interceptable (CLI self-manages).
- `git-diff` with pure additions is not meaningfully compressible (passthrough) — the diff *is* the content.
- Optimizers are syntactic, not semantic (no LLM) — they cannot summarize meaning, only re-present
  the same information more densely.

## Default-enabled?

**Yes for the API agent path.** The optimizers are lossless-first and fail-closed (passthrough),
so default-enable is safe. It is trivially disableable by passing a no-op `optimizeOutput`.

## Next recommendation

Repo Intelligence Map (token-budgeted tree-sitter/ctags symbol map injected into `ContextEnvelope`),
per `INTEGRATION_PLAN.md` order #2.
