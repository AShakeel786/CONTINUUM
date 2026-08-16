# Repo Intelligence Map — Benchmark

**Method:** `buildRepoMap` run against CONTINUUM itself for four representative tasks; measured with
CONTINUUM's own `estimateTokens` (js-tiktoken). Run: `node scripts/repo-map-benchmark.mjs`.

## Results (budget 1200 tokens, 142 files, 566 symbols)

| Task (query) | Map tokens | Cold build | Warm (cached) build |
|---|---|---|---|
| locate-auth-provider ("credential provider auth") | 1202 | 239 ms | 42 ms |
| trace-launch-session-handoff ("launcher session handoff") | 1202 | 31 ms | 30 ms |
| find-mcp-memory ("mcp memory tool") | 1202 | 37 ms | 32 ms |
| known-bug-health-recovery ("health recovery doctor repair") | 1202 | 31 ms | 30 ms |

**Avg map tokens: 1202** (hits the budget — CONTINUUM is small enough that all 142 files fit).

## Correctness (fidelity)

Under a *tight* budget (300 tokens) the ranking surfaces the right files first:

- "credential provider auth" → `src/auth/types.ts`, `src/auth/provider-auth/index.ts`,
  `src/providers/types.ts`, `src/auth/credential-manager.ts` (top-ranked).
- "mcp memory" → `src/mcp/*` files ranked first.

All required symbols remain present in the map; the map contains no file *contents* (navigation only).

## What this means

- **Repo-map tokens:** bounded to the configured budget (1200 by default) regardless of repo size.
- **Search/read/tool calls avoided:** the map is a *navigation aid* — it is not claimed to eliminate
  searches; its value is giving the agent a stable, budgeted directory of symbols so it can choose the
  right files to read on the first try instead of exploring. This is measured qualitatively (relevant
  files surfaced), not as a "calls avoided" count, which would depend on the agent and task.
- **Total task input tokens:** unchanged from baseline *plus* the map tokens (the map is an additional
  stable block, not a replacement). For large repos, the map is cheaper than the reads it helps avoid.
- **Latency:** cold ~240 ms (one-time per repo state), warm ~30–50 ms (cached) — negligible vs a turn.

## Baseline vs repo-map enabled

- **Baseline:** no repo map; agent discovers structure by trial (multiple list/search/read calls).
- **Enabled:** +1200 tokens of stable context, one-time ~240 ms build, then cached; the agent receives
  a ranked symbol directory up front.

These numbers are CONTINUUM's own measurements, not any upstream project's claims.

## Limitations

- Regex parser is coarser than tree-sitter (no full symbol graph/references; only top-level names +
  relative imports). A tree-sitter/ctags upgrade would improve precision.
- CONTINUUM is small enough that the budget is never the binding constraint; ranking is only exercised
  under tight budgets or on larger repos.
