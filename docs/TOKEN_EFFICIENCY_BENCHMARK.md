# Tool Output Optimizer — Benchmark

**Method:** representative corpus (generated realistically, not from any upstream project's
claimed numbers); measured with CONTINUUM's own `estimateTokens` (js-tiktoken `o200k_base`).
Run: `node scripts/tool-output-benchmark.mjs` (after `npm run build`).

## Results

| Corpus | Optimizer | Original tokens | Optimized tokens | % saved | Raw retained |
|---|---|---|---|---|---|
| large-test-output | test-runner | 1699 | 58 | 96.6% | yes |
| git-diff (pure additions) | passthrough | 781 | 781 | 0% | no |
| git-status | git-status | 614 | 364 | 40.7% | yes |
| git-log | git-log | 1720 | 319 | 81.5% | yes |
| compiler-output | compiler | 761 | 61 | 92.0% | yes |
| json | json | 9009 | 4605 | 48.9% | yes |
| app-logs | log-dedup | 3816 | 1396 | 63.4% | yes |
| dir-listing | file-listing | 4243 | 723 | 83.0% | yes |

**Total measured reduction: 63.3%** (22,643 → 8,307 tokens across the corpus).

## Notes

- These are *this benchmark corpus* results, not a guarantee for every workload — and they are
  "tool-output token reduction", not a reduction in the overall bill (system prompt + history +
  output tokens are unaffected, exactly as RTK correctly caveats).
- `git-diff` passes through when the diff is entirely additions (nothing safe to drop); real diffs
  with unchanged context lines reduce by dropping context.
- `json` minification alone is ~49% on pretty-printed JSON; on already-minified JSON it is a passthrough.

## Fidelity (adversarial)

- An error buried inside 200 repetitive INFO log lines survives `log-dedup` verbatim.
- FAIL + expectation + stack trace survive `test-runner` collapse.
- All filenames survive `git-status` collapse; `(use git add …)` hints are dropped.
- Raw output retrievable byte-for-byte via `tool_output_retrieve`.
