# Phase 4 Entry Criteria

Phase 3 (Provider Adapter foundation) is closed — see `PHASE_3_PROVIDER_ARCHITECTURE.md` and `PHASE_3_VERIFICATION.md`. This lists what's satisfied, what Phase 3 revealed (documented only, per the hard boundary — nothing below was built), and decisions needed before Phase 4 starts.

## Satisfied

- [x] Data-driven `ProviderRegistry` + `ProviderProfile`/`ProviderAdapter` contract built and tested (32/32 CONTINUUM tests).
- [x] Claude + DeepSeek proven through the *same* adapter implementation, not just the same interface.
- [x] Native Anthropic `LLMRunner` built in MemoryCore through the existing, unmodified `LLMRunner`/`LLMRunnerFactory` interfaces (8/8 tests, MemoryCore's first test file).
- [x] Secrets verified external (`SecretRef`-only, tested) across every profile and the Tencent-side change.
- [x] Existing Tencent deployment verified healthy before and after (10/10 containers, MemoryProxy's 54/54 regression suite unaffected).
- [x] Nothing committed or pushed (per Phase 3's rules) — all CONTINUUM files are new/untracked, all Tencent changes sit alongside the existing uncommitted pre-existing files, explicitly not staged.

## What Phase 3 revealed (documented only — none of this was built, per the hard boundary)

1. **The native Anthropic `LLMRunner` isn't reachable from a running Gateway yet.** `StandaloneHostAdapter` still unconditionally constructs `StandaloneLLMRunnerFactory`. Wiring config-driven provider selection (so `GatewayConfig`'s `llm` section could actually choose `AnthropicLLMRunnerFactory`) is real, natural next work — but it means touching `StandaloneHostAdapter`/`GatewayConfig`, which Phase 3's "do not redesign MemoryCore" ruled out. A small, explicitly-scoped follow-up.
2. **A real, pre-existing bug in `StandaloneLLMRunner`:** it reads `result.usage.promptTokens`/`.completionTokens` from the Vercel AI SDK, but `ai@^6.0.164`'s actual `LanguageModelUsage` shape uses `inputTokens`/`outputTokens` — token usage has been silently reporting zero on every real call. Found via the new `AnthropicLLMRunner` test suite, not introduced by it. Small, isolated, one-line-per-field fix; not made this phase since it's unrelated to the Provider Adapter work and touches `StandaloneLLMRunner` itself.
3. **The CLI launch plan (`buildCliLaunchPlan()`) is ready to be consumed by a real launcher, but isn't wired into one.** `windows/launch-tencent-claude.ps1` is untouched, as instructed. The data it would need (executable, env, clearEnvVars, configDir) now exists and is tested for both providers — CLI/Launcher work (explicitly lower-priority in `CONTINUUM_ARCHITECTURE.md`'s original sequencing, "worth doing once the provider layer has something new to route to") now has that something.
4. **`Protocol`/`AuthStrategy`/`CliLaunchDescriptor` are 2-member unions today** (anthropic-messages/openai-compatible; 4 auth kinds; native/proxy-routed). Adding Gemini would very likely need a genuinely new `Protocol` value and possibly a new `CliLaunchDescriptor` kind if its CLI story doesn't fit "native" or "proxy-routed" — not yet exercised with a real third provider, so this is a prediction, not a verified fact.

## Decisions needed from you before Phase 4 starts

1. **Which Phase 4 direction?** `PHASE_2_RECOMMENDATIONS.md`'s original sequencing (still valid) put **Context Manager consolidation** right after Provider Adapters — it's what actually closes R-16/R-17 (native Claude/Codex sessions get no memory injection today), and both Prompt Cache Intelligence and a real Agent Router depend on it existing first. Recommended default. Alternatives: wire the native Anthropic runner into the Gateway (item 1 above, smaller/faster), or fix the `StandaloneLLMRunner` usage bug (item 2, trivial but unrelated) as a standalone patch first.
2. **Gemini/Codex/local models — build now or stay at 2 providers?** The brief's own sequencing says wait ("full multi-provider parity... sequence after the foundation is proven with Claude + DeepSeek, not before") — proven now, but adding a third provider before Context Manager exists would mean building memory-blind integrations again (same gap R-17 already describes for native Claude/Codex). Recommend deferring until Context Manager lands.
3. **Fix the `StandaloneLLMRunner` usage-tracking bug?** Independent of everything else, small, but touches `StandaloneLLMRunner` directly (a file Phase 3 deliberately left alone) — needs its own go-ahead the same way Phase 2's security punch-list did.

## Recommended Phase 4 starting point

Per `PHASE_2_RECOMMENDATIONS.md`, unchanged by anything Phase 3 found: **Context Manager consolidation** — pick the `auto-recall.ts` stable/dynamic design (already the most mature of the three context-assembly implementations the Phase 1 audit found) and make it the one path every provider integration calls through, closing the "native Claude/Codex get no memory" gap. The Provider Registry built this phase gives Context Manager a real, tested notion of "which provider" to target instead of assuming DeepSeek-via-proxy is the only path, which is what today's `auto-recall.ts` implicitly does.
