# CONTINUUM

A multi-agent development runtime: orchestration across agents, seamless mid-task handoff, shared persistent memory, project isolation, prompt/context-caching optimization, and support for Claude Code, DeepSeek, Gemini, and local models — through a common provider and tool layer.

## Status: Phase 4 complete (context, cache & token intelligence)

Phase 1 audited the existing [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) deployment at `C:\Users\arsla\Documents\Ai-tools\TencentDB-Agent-Memory` — the system currently used to launch Claude Code / DeepSeek / Codex sessions for 8 real projects — to determine what becomes CONTINUUM's memory/context infrastructure layer, what needs refactoring, and what's missing entirely. Phase 2 (+ 2.1) then closed the security/stability findings that audit surfaced (credential exposure, broken proxy↔core auth, insecure defaults, a Windows `python3` dependency failure, and more), rebuilt and redeployed the affected Docker images, and verified the real live deployment (all 8 projects) still works with zero regressions. Phase 3 built CONTINUUM's first feature code: a data-driven provider registry (`src/providers/`) proven with Claude and DeepSeek, and a native Anthropic `LLMRunner` in MemoryCore.

**Phase 4 built the context pipeline everything else depends on.** `src/context/` is CONTINUUM's single, provider-independent Context Manager — a `ContextEnvelope` of provenance-tagged, deterministically-ordered content blocks, fed real Tencent Memory through MemoryCore's existing Gateway API (no engine changes). `src/token/` budgets it against a provider's real context window using an actual BPE tokenizer, trimming deterministically by priority while leaving critical instructions genuinely untouchable. `src/cache/` adds real Anthropic `cache_control` emission and real cache-hit/miss telemetry parsing for both Claude and DeepSeek, verified field-for-field against MemoryProxy's existing production billing code — no fabricated numbers anywhere. `src/rendering/` proves Claude and DeepSeek render the *same* selected content through the *same* pipeline. `src/native-claude/` is a tested harness proving native Claude — one of the two agent paths Phase 1 found gets zero memory injection today — can now receive real Tencent Memory context, without touching the production launcher. Along the way, a real, previously-unknown bug was found and fixed in `MemoryCore/src/adapters/standalone/llm-runner.ts`: token usage had been silently reporting zero on every call since an AI SDK upgrade. See `docs/PHASE_4_CONTEXT_ARCHITECTURE.md`, `docs/PHASE_4_CACHE_TOKEN_REPORT.md`, `docs/PHASE_4_VERIFICATION.md`, and `docs/PHASE_5_ENTRY_CRITERIA.md` for what's next.

Read the docs:

| Doc | Contents |
|---|---|
| [`docs/PHASE_1_EXISTING_SYSTEM_AUDIT.md`](docs/PHASE_1_EXISTING_SYSTEM_AUDIT.md) | Component-by-component audit of the current Tencent system, verified by reading source. |
| [`docs/RUNTIME_FLOW.md`](docs/RUNTIME_FLOW.md) | Traced execution flow: launcher → project selection → agent → proxy → model API → memory → response. |
| [`docs/RISKS_AND_TECH_DEBT.md`](docs/RISKS_AND_TECH_DEBT.md) | 33 findings, severity-ranked, from the Phase 1 audit. |
| [`docs/TENCENT_MIGRATION_MAP.md`](docs/TENCENT_MIGRATION_MAP.md) | Per-module: reuse as-is, refactor, build new, or discard. |
| [`docs/CONTINUUM_ARCHITECTURE.md`](docs/CONTINUUM_ARCHITECTURE.md) | Proposed module design, with two refinements to the original skeleton driven by audit findings. |
| [`docs/PHASE_2_RECOMMENDATIONS.md`](docs/PHASE_2_RECOMMENDATIONS.md) | Originally-proposed Phase 2 scope — this is what Phase 2 actually executed. |
| [`docs/PHASE_2_SECURITY_STABILITY_REPORT.md`](docs/PHASE_2_SECURITY_STABILITY_REPORT.md) | What was fixed, how it was verified (including a real bug caught and corrected mid-phase), before/after status, pass/fail. |
| [`docs/PHASE_2_TEST_MATRIX.md`](docs/PHASE_2_TEST_MATRIX.md) | Every verification item, method, and result — unit tests and live-container tests against the real deployment. |
| [`docs/TENCENT_SECURITY_POSTURE.md`](docs/TENCENT_SECURITY_POSTURE.md) | Current-state security snapshot: what's closed, what's contained-not-eliminated, what's still out of scope. |
| [`docs/PHASE_3_ENTRY_CRITERIA.md`](docs/PHASE_3_ENTRY_CRITERIA.md) | What's satisfied, what decisions are still needed from you, and the recommended Phase 3 starting point. |
| [`docs/PHASE_2_1_BASELINE_CLOSURE.md`](docs/PHASE_2_1_BASELINE_CLOSURE.md) | Closed the remaining baseline gaps before Phase 3: Phase 2 commit, the Windows `python3`→`node` registry-parsing fix, and completing the R-8 upstream-key migration on all 8 live proxy configs. |
| [`docs/PHASE_3_PROVIDER_ARCHITECTURE.md`](docs/PHASE_3_PROVIDER_ARCHITECTURE.md) | The provider registry/adapter design (`src/providers/`), why `cliLaunch` is modeled separately from direct-call `protocol`/`auth`, and the native Anthropic `LLMRunner` added to MemoryCore. |
| [`docs/PHASE_3_VERIFICATION.md`](docs/PHASE_3_VERIFICATION.md) | Every test the brief required, what covers it, and the Tencent-deployment regression check. |
| [`docs/PHASE_4_ENTRY_CRITERIA.md`](docs/PHASE_4_ENTRY_CRITERIA.md) | What Phase 3 revealed but deliberately didn't build, decisions needed from you, and the recommended Phase 4 starting point (Context Manager consolidation). |
| [`docs/PHASE_4_CONTEXT_ARCHITECTURE.md`](docs/PHASE_4_CONTEXT_ARCHITECTURE.md) | The `ContextEnvelope` design, why it's blocks not strings, where Tencent Memory data actually comes from (and a real gap found in the Gateway's own `/recall` endpoint along the way), and the `StandaloneLLMRunner` fix. |
| [`docs/PHASE_4_CACHE_TOKEN_REPORT.md`](docs/PHASE_4_CACHE_TOKEN_REPORT.md) | Token Manager and Prompt Cache Intelligence detail — exactly which numbers are real/provider-verified vs. estimated, field-by-field, for both Claude and DeepSeek. |
| [`docs/PHASE_4_VERIFICATION.md`](docs/PHASE_4_VERIFICATION.md) | Every test the brief required, what covers it, the Tencent regression check, and what a live (but empty-scope) run against the real MemoryCore Gateway did and didn't prove. |
| [`docs/PHASE_5_ENTRY_CRITERIA.md`](docs/PHASE_5_ENTRY_CRITERIA.md) | What Phase 4 revealed but deliberately didn't build, decisions needed from you, and the recommended Phase 5 starting point (agent/task session-state layer). |

## Relationship to Tencent

TencentDB Agent Memory is **not discarded** — it becomes CONTINUUM's memory/context infrastructure layer. The audit found its memory engine (`MemoryCore`, the L0→L3 pipeline, storage backends, host-adapter architecture) is cleanly host-agnostic by design and directly reusable. The proxy/context-injection layer (`MemoryProxy`) is ~70% provider-agnostic and reusable as CONTINUUM's context/observability middleware, with the Claude-Code/DeepSeek-specific parts isolated to a small, well-factored adapter surface.

What the audit found was genuinely missing — and what CONTINUUM adds on top of Tencent's memory layer — is: mid-task agent handoff (doesn't exist today in any form), a unified context-assembly path, a real multi-provider abstraction, and an MCP/tool layer (zero MCP code exists anywhere in the current system). Phase 3 built the provider abstraction, proven with Claude and DeepSeek (`src/providers/`) — Gemini/Codex/local models still don't exist, but adding them is now a matter of adding a profile, not rewriting routing logic. Phase 4 built the unified context-assembly path (`src/context/`) and proved, via a tested harness, that native Claude sessions — memory-blind today in the real launcher — can receive real Tencent Memory through it (`src/native-claude/`); Codex remains unwired, and the production launcher itself is untouched, both deliberately (see `docs/PHASE_4_VERIFICATION.md`). Mid-task agent handoff and the MCP/tool layer remain unbuilt.

## Canonical repo

`https://github.com/AShakeel786/CONTINUUM`
