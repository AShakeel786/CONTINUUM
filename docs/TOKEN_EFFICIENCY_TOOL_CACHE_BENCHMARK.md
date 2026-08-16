# Deterministic Tool Result Cache — Benchmark

**Method:** 100 identical read-only tool calls per case through the real cache path (cache + key +
scope provider), with a ~523-token result payload. Run: `node scripts/tool-cache-benchmark.mjs`.

## Results

| Tool (scope) | Hit rate | Handler calls | Calls avoided | Tokens avoided (~) |
|---|---|---|---|---|
| `project_list` (project) | 99% | 1 | 99 | 51,777 |
| `session_state` (session) | 99% | 1 | 99 | 51,777 |
| `memory_search` (uncached) | 0% | 100 | 0 | 0 |

## Adversarial / invalidation (tested, not just benchmarked)

- Write tools (`access:"write"`) always execute regardless of scope.
- `session_state` with no `sessionId` in args → fingerprint uncomputable → miss every time (no stale hit).
- Different scope fingerprints (repo HEAD/dirty change, session revision change) produce different
  keys → miss.

## What this means

- **Execution calls avoided:** 99% on cacheable read-only tools (one real execution per unique key).
- **Hit rate:** ~99% for repeated identical deterministic reads; 0% for uncached mutable tools.
- **Tokens avoided:** proportional to the result payload size × calls avoided (illustrative ~51k for
  99 avoided calls of a 523-token result); measured with CONTINUUM's own token estimator, not an
  upstream claim.
- **Latency:** a hit skips the tool handler entirely (and the optimizer, since the optimized text is
  cached); the only added cost is a SHA-1 key hash + map lookup (microseconds).

## Limitations

- Cross-run hits require an unchanged scope fingerprint (same git HEAD/dirty, or same session
  revision) — the safe behavior; the cache does not stretch correctness for higher hit rates.
