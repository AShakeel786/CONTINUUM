# Reversible Context Pruning — Benchmark

**Method:** a synthetic long-session envelope (instructions + 30 conversation turns + 30 tool results
+ 20 recalled-memory + 10 project-context blocks) budgeted to a 4k-token context window, run through
`allocateBudget` + `applyReversiblePruning`. Run: `node scripts/pruning-benchmark.mjs`.

## Results

| Metric | Value |
|---|---|
| Baseline active tokens (unpruned) | 7,130 |
| Active tokens after pruning | 5,315 |
| Tokens externalized (retrievable) | 3,660 |
| Blocks pruned | 48 |
| **Net reduction** | **25.5%** |

## What this means

- Active prompt shrinks ~25%; the pruned full content (3,660 tokens) is persisted and retrievable
  byte-for-byte via `context_retrieve`.
- The reference blocks themselves cost a small amount (the difference between "kept" and "active after"),
  so the net saving is the externalized tokens minus reference overhead — still a clear win.

## Adversarial / fidelity (tested, not just benchmarked)

- Important old error referenced later → retrievable via `context_retrieve` (byte-for-byte).
- Stale context needed after handoff → persisted under the session key; `clearSession` removes it on end.
- Storage missing/corrupt → `get` returns "not found" (never a fabricated result); `put` failure → the
  original block is kept (fail-closed).
- Critical instruction pressure → `instructions` and `current-task` are never pruned (protected).
- Retrieval after process restart → `FilePruneStore` re-reads the same disk dir (tested).

## Limitations

- Pruning applies to the ContextEnvelope CONTINUUM assembles; native CLIs manage their own internal
  history (out of CONTINUUM's control).
- References are deterministic, no summarization — the "label" is only the first line, so a pruned block
  is identified by provenance + class, not a semantic summary.
