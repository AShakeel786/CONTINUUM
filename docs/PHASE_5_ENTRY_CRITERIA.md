# Phase 5 Entry Criteria

Phase 4 (Context, Cache & Token Intelligence) is closed — see `PHASE_4_CONTEXT_ARCHITECTURE.md`, `PHASE_4_CACHE_TOKEN_REPORT.md`, `PHASE_4_VERIFICATION.md`. This lists what's satisfied, what Phase 4 revealed (documented only, per the hard boundary — nothing below was built), and decisions needed before Phase 5 starts.

## Satisfied

- [x] One canonical `ContextEnvelope`/Context Manager, enforced (not just documented) as the single assembly path.
- [x] Tencent memory mapped into it via MemoryCore's existing `/v3/*` Gateway API — zero MemoryCore engine changes.
- [x] Deterministic stable/dynamic ordering, tested for order-independence.
- [x] `StandaloneLLMRunner`'s token-usage bug fixed and regression-tested (2-line fix, 5 new tests).
- [x] Token Manager: real tiktoken-based estimation (clearly labeled, never conflated with provider-exact), deterministic priority-based trimming, `instructions` genuinely untouchable.
- [x] Prompt Cache Intelligence: real Anthropic `cache_control` emission, real DeepSeek telemetry parsing (verified against `MemoryProxy/src/credit-reporter.ts`'s production billing code), no fabricated cache-hit numbers or $ savings figures.
- [x] Provider rendering proven to select identical content for Claude and DeepSeek — only serialization differs.
- [x] Native Claude context assembly proven via a tested harness (mocked + one live, empty-scope-verified run) — R-17's memory-blind gap closed at the CONTINUUM layer, launcher untouched.
- [x] 95 (CONTINUUM) + 13 (MemoryCore) + 54 (MemoryProxy) tests passing; live Tencent stack healthy throughout; nothing committed or pushed.

## What Phase 4 revealed (documented only — none of this was built, per the hard boundary)

1. **The native Claude harness was only live-verified against an empty-scope identity.** A synthetic test `userId` has no real conversation history, so the live run proved wire correctness and empty-scope safety, not non-empty real recall flowing end-to-end against production data. Worth a small, deliberate follow-up: either a disposable seeded test identity (mirroring Phase 2.1's disposable-tagged `/capture` test pattern) or explicit access to a real user identity's data, with the user's go-ahead given it touches real memory content.
2. **Anthropic cache TTL selection (5m vs 1h) and multi-breakpoint strategies are not implemented.** The current code always uses the default ephemeral marker with no TTL override, and emits exactly one breakpoint at the end of the stable prefix. No evidence from this phase's work suggested either was needed yet; would need a concrete driving case (e.g. measured cache-miss patterns from real usage) before adding either, per "do not over-engineer."
3. **Cache invalidation cannot yet name which specific block changed** — `PrefixStabilityTracker` retains only a hash, not the previous envelope, so `invalidationReason` describes current composition, not a diff. A precise per-block diff would need retaining the previous envelope per session, which edges toward session-state retention beyond what this phase's "no durable task/session-state architecture" boundary allows.
4. **`AnthropicLLMRunner` (built Phase 3) is still not wired into MemoryCore's Gateway factory selection.** Unrelated to this phase's context work specifically, but still the same standing item from `PHASE_4_ENTRY_CRITERIA.md`'s (this doc's Phase-3-authored predecessor) item 1 — untouched again this phase since it wasn't in scope.
5. **No $ cost-savings figure is computed anywhere in the cache telemetry.** `estimatedSavingsTokens` is deliberately just `cachedTokens` relabeled — CONTINUUM has no authoritative multi-provider pricing table. If a dollar figure is wanted, it needs real pricing data sourced explicitly (e.g. from `MemoryProxy`'s own `CreditPricingConfig`, which does exist for TokenHub-priced models) rather than CONTINUUM inventing or duplicating one.

## Decisions needed from you before Phase 5 starts

1. **Which Phase 5 direction?** `PHASE_2_RECOMMENDATIONS.md`'s original sequencing, still valid: **Agent/task session-state layer + Agent Handoff prototype** is the next item that specifically depends on Context Manager existing (it now does) — handoff needs *something* to summarize, and that's now available. Alternative: **MCP wrapper around MemoryCore's Gateway API**, independent of everything else, can run in parallel with anything.
2. **Pursue the live non-empty-recall verification (item 1 above)?** Needs either a disposable seeded identity or real user data access — either way, a deliberate choice given it touches real memory content, not something to do silently as part of "just checking."
3. **Gemini/Codex/local-model providers — build now or stay at 2?** The provider foundation (Phase 3) and now the Context Manager (Phase 4) are both proven; the blocker `PHASE_4_ENTRY_CRITERIA.md` originally cited (Gemini would be memory-blind without Context Manager) no longer applies. Still recommend deferring unless there's a concrete need, since the closed-union `Protocol`/`CliLaunchDescriptor` types would very likely need a genuinely new variant for Gemini, not exercised or verified this phase.

## Recommended Phase 5 starting point

**Agent/task session-state layer**, per the original Phase 2 sequencing — it's the harder design problem underlying Agent Handoff, and Context Manager (this phase) plus the Provider Registry (Phase 3) give it real primitives to build on: a session-state package can now reference a real `ContextEnvelope` snapshot and a real `ProviderAdapter` id, not placeholders. Handoff itself would then be a comparatively thin consumer of that state once it exists.
