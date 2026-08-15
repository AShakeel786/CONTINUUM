# Phase 4 — Verification

Companion to `PHASE_4_CONTEXT_ARCHITECTURE.md` and `PHASE_4_CACHE_TOKEN_REPORT.md`. Every test bullet the brief listed, what covers it, and the result.

---

## 1. Starting-state verification

- `git status --porcelain` in both repos, before any change: Tencent matched Phase 3's closing state exactly (15 pre-existing modified files, 9 pre-existing untracked paths — unchanged); CONTINUUM had exactly the Phase 3 files (`providers/`, `package.json`, etc.), nothing else.
- Live Tencent stack: 10/10 containers healthy before starting.
- Phase 3's `StandaloneLLMRunner` finding was re-verified by re-reading the code (§4 below), not assumed correct from memory.

## 2. CONTINUUM test suite

**Command:** `npx vitest run` in `CONTINUUM/`. **Result: 95/95 passing, 15 files** (32 carried over from Phase 3 + 63 new this phase). **Typecheck:** `npx tsc --noEmit`, clean, `strict: true`.

| Brief's test bullet | File(s) | Covered by |
|---|---|---|
| Stable/dynamic context separation | `context/__tests__/envelope.test.ts` | Persona/scene-index land in `stable`, recalled-memory in `dynamic`, verified with zero class overlap between sections |
| Deterministic ordering | `context/__tests__/ordering.test.ts` | Fixed class sequence regardless of input order; score-descending within a class; id as total tiebreaker; explicit no-mutation check |
| Tencent recall → ContextEnvelope | `context/__tests__/memorycore-client.test.ts` (mocked), plus a live run against the real Gateway (§5) | Full round-trip: mocked `/v3/core/read` + `/v3/atomic/search` responses → `buildContextEnvelope` → correct blocks with correct provenance |
| Token accounting bug regression | `MemoryCore/src/adapters/standalone/__tests__/llm-runner.test.ts` (Tencent repo) | 5 tests, see §4 |
| Token budgets and trimming priority | `token/__tests__/budget.test.ts` | Lowest-priority `recalled-memory` dropped before a higher-priority one under a tight budget; deterministic across repeated runs on the same input |
| Critical-context preservation | `token/__tests__/budget.test.ts` | "instructions" class survives extreme pressure untouched; `criticalContentOverBudget` flag when instructions alone exceed the budget, envelope left completely unchanged |
| Provider-specific rendering | `rendering/__tests__/render.test.ts` | Claude → array of Anthropic content blocks; DeepSeek → joined string; both proven to select identical underlying content (re-joined Claude text equals DeepSeek's string) |
| Anthropic cache directives | `cache/__tests__/directives.test.ts` | Exactly one `{type:"ephemeral"}` marker on the last stable block; none for an empty stable section |
| DeepSeek cache behavior handling | `cache/__tests__/directives.test.ts`, `cache/__tests__/telemetry.test.ts` | No directive emitted (capability-gated, not provider-id-gated); real field-mapping telemetry parsing (`cache_read_tokens`, `prompt_tokens_details.cached_tokens`) verified against `credit-reporter.ts` |
| Cache invalidation detection | `cache/__tests__/invalidation.test.ts` | Stable-across-turns → `stable: true`; content change → `stable: false` with a reason; independent per-session tracking; `forget()` resets state |
| Cache telemetry parsing | `cache/__tests__/telemetry.test.ts` | Real Anthropic cache-hit/cache-write field combinations; real DeepSeek field combinations (both naming variants); explicit `available: false` for a response with no usable fields, never a fabricated zero |
| No secret leakage | `providers/__tests__/no-secrets.test.ts` (Phase 3) + secret-shaped-string sweeps of every new module (`context`, `token`, `cache`, `rendering`, `native-claude`) | Zero hits outside known test fixtures |
| Unknown/unsupported cache mode | `cache/__tests__/directives.test.ts` | `promptCache: "none"` capability → empty directive list, not a guess |
| Native Claude context assembly | `native-claude/__tests__/assemble.test.ts` (mocked) + a live run (§5) | Full pipeline: mocked MemoryCore recall → envelope → budget → Anthropic-rendered output, including a real cache directive |
| Existing Phase 3 provider tests | `providers/__tests__/*` | All 32 still pass after this phase's profile edits (added `contextWindowTokens`, updated `notes` text) |

## 3. Tencent regression suites

- **MemoryCore:** `npx vitest run` → **13/13 passing** (8 from Phase 3's `anthropic-llm-runner.test.ts` + 5 new from this phase's `llm-runner.test.ts`).
- **MemoryProxy:** `npm test` → **54/54 passing** — identical to every prior phase's baseline. This phase touched zero MemoryProxy files.
- **Live stack:** `docker ps` → **10/10 containers healthy**, before and after.
- **`git status --porcelain` diff, before vs. after (Tencent repo):** exactly two new changes beyond the pre-existing baseline — `MemoryCore/package.json` (unchanged from Phase 3's `@ai-sdk/anthropic` addition — no new edit this phase) and `MemoryCore/src/adapters/standalone/llm-runner.ts` (the two-line fix), plus the new `__tests__/llm-runner.test.ts` file. Nothing pre-existing was touched.

## 4. Token-accounting fix, re-verified

Re-read `MemoryCore/src/adapters/standalone/llm-runner.ts` before changing anything (per the brief's "re-verify the Phase 3 finding"). Confirmed the exact same bug Phase 3 found: `result.usage.promptTokens`/`.completionTokens` don't exist on `ai@^6`'s `LanguageModelUsage` (`node_modules/ai/dist/index.d.ts` line 270 confirms the real fields are `inputTokens`/`outputTokens`). Fixed the two field reads; left `LLMUsage`'s own output shape (the class's public contract) untouched. 5 new tests, mocked fetch, exercising the real `@ai-sdk/openai` request/response path:
- Text output still correct after the fix.
- Non-zero provider usage maps to non-zero `lastUsage` (the exact shape the bug took, asserted directly — not just "equals expected value").
- A response with no `usage` block at all maps to a zeroed (not undefined) `lastUsage` — verified real AI SDK behavior (it synthesizes a zeroed usage object) rather than assumed.

## 5. Live verification against the real MemoryCore Gateway

Beyond mocked tests, ran `assembleNativeClaudeContext` once against the actual, running `tdai-memory-core` container (`http://127.0.0.1:8420`), read-only (`/v3/core/read`, `/v3/scenario/ls`, `/v3/atomic/search` never mutate). The live Gateway's own `TDAI_GATEWAY_API_KEY` is unset in this deployment (confirmed: `checkAuth` is a documented no-op when unconfigured — Phase 2's `server.ts` comment), so a placeholder Bearer value was used; no real secret was needed or exposed.

**Result: the call succeeded with zero errors and correct response shapes, but returned zero stable/dynamic blocks** — a synthetic test `userId` (`live-verify-user`) with no real conversation history was used, and L1/L3 content is scoped per team+user+agent. This is the correct, expected empty-scope behavior (the exact same code path the mocked "cold profile" test already covers), not a bug — but it means the live run proved **wire correctness and empty-scope safety**, not **non-empty real recall content flowing through**. Deliberately not chased further by guessing at real user IDs against the live production system, which felt like the wrong kind of probing for a verification step. The mocked test (`assemble.test.ts`) is what proves the non-empty-recall path; this live run is what proves that path is reachable at all against real infrastructure. Both are needed; neither alone would be sufficient, and conflating them would overstate what was actually shown.

## 6. Pass/fail against the brief's closure criteria

| Criterion | Status |
|---|---|
| 1. One canonical Context Manager exists | ✅ — `buildContextEnvelope`, enforced as the only construction path via class-allowlist validation |
| 2. Tencent memory is mapped into it | ✅ — via MemoryCore's `/v3/*` Gateway API, the same endpoints MemoryProxy already uses in production |
| 3. Stable/dynamic context is deterministic | ✅ — `orderBlocks`, tested for order-independence and idempotence |
| 4. Token usage accounting is correct | ✅ — `StandaloneLLMRunner` fixed and regression-tested; `AnthropicLLMRunner` (Phase 3) was already correct |
| 5. Token budgeting/trimming is tested | ✅ — priority-ordered, critical-content-exempt, deterministic, 8 tests |
| 6. Claude cache directives/telemetry work where supported | ✅ — real directive emission + real field-mapping telemetry, verified against production billing code |
| 7. DeepSeek caching is handled per verified capabilities | ✅ — correctly emits no directive (automatic/server-side), parses real hit/miss telemetry |
| 8. Provider rendering uses the same canonical context | ✅ — proven directly: re-joined Claude output equals DeepSeek's output |
| 9. Native Claude can receive assembled Tencent context in a tested path | ✅ — mocked end-to-end test + one live (empty-scope, wire-verified) run; not wired into the real launcher, as instructed |
| 10. All regression tests pass | ✅ — 95 (CONTINUUM) + 13 (MemoryCore) + 54 (MemoryProxy) |
| 11. Live Tencent deployment remains healthy | ✅ — 10/10 containers, before and after |

**PHASE 4 PASSED.**
