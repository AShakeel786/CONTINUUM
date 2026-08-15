# Phase 4 — Context, Cache & Token Intelligence: Architecture

**Scope:** one provider-independent Context Manager, a Token Manager that budgets it, a Prompt Cache Intelligence layer that annotates it per provider capability, and a proof that native Claude can receive it — plus the confirmed `StandaloneLLMRunner` token-usage fix. See `PHASE_4_CACHE_TOKEN_REPORT.md` for the token/cache implementation detail and `PHASE_4_VERIFICATION.md` for full test results.
**Repos touched:** `CONTINUUM` (all new context/token/cache/rendering/native-claude code) and `TencentDB-Agent-Memory` (`MemoryCore/src/adapters/standalone/llm-runner.ts` — the token-usage fix only; see §5).
**Date:** 2026-08-15/16.

---

## 1. What was read before designing anything, and why it changed the design

Per the brief, `auto-recall.ts`'s stable/dynamic split was the starting pattern. Reading it plus the two other paths the Phase 1 audit flagged (R-16) as divergent gave a more precise picture than the audit's own one-line summary, worth stating exactly:

- **`MemoryCore/src/core/hooks/auto-recall.ts`** (OpenClaw-embedded): splits into `appendSystemContext` (L3 persona + L2 scene nav + a static tools guide — stable) and `prependContext` (L1 relevant memories — dynamic), with its own `applyRecallBudget` truncation.
- **`MemoryProxy/src/injection/injectors/{tdai-profile-memory-injector,tdai-l1-recall-injector}.ts`**: a *second*, independently-written implementation of essentially the same split — persona+scene-index injected at `system.suffix` with `cacheStrategy: "session_init"` (prewarmed once, not per-turn), L1 recall injected at `user.before` with no caching, merged across "self + imported" agents. **Correction to R-16's framing**: this isn't a design that *lacks* the stable/dynamic concept, as the audit's phrasing could be read to imply — it's a second, real implementation of a similar concept, with its own caching semantics and its own endpoints. The actual problem R-16 describes is duplication (two hand-written, non-shared implementations of the same idea), not that one of them is unstructured.
- **The Gateway's own v1 `/recall` HTTP endpoint** (`MemoryCore/src/gateway/server.ts`, `handleRecall`): a real, previously-unremarked gap, found by reading the handler, not assumed. `RecallResponse.context` is set to `result.appendSystemContext` only — **`prependContext` (the dynamic L1 half) is silently dropped from the HTTP response entirely.** Any caller integrating purely through `/recall` gets the stable half and nothing else. This directly shaped where CONTINUUM's Context Manager gets its data (§2).

## 2. Where CONTINUUM's Context Manager actually gets MemoryCore data

Given `/recall`'s gap, three options existed: (a) use `/recall` for stable + accept no dynamic recall via the Gateway boundary, (b) fork/extend the Gateway to add a v1 endpoint that returns both halves, or (c) call the same `/v3/*` "strong isolation" endpoints `MemoryProxy/src/tdai/client.ts` **already calls in production** for exactly this purpose. Chose (c) — it's the proven, working boundary, requires zero MemoryCore changes (satisfying "do not fork/rewrite the L0→L3 engine"), and returns **structured, individually-provenanced items**, not a pre-rendered blob:

| Content | Endpoint | Response shape (verified against `TdaiClient`) |
|---|---|---|
| L3 persona | `POST /v3/core/read` | `{ content, updated_at? }` |
| L2 scene index | `POST /v3/scenario/ls` | `{ entries: [{ path, summary?, updated_at? }] }` |
| L1 relevant recall | `POST /v3/atomic/search` | `{ items: [{ id, type, content, score, updated_at }] }` |

`src/context/memorycore-client.ts` calls exactly these three, with the same isolation headers (`x-tdai-team-id`/`user-id`/`agent-id`/`session-id`/`task-id`) and Bearer auth `TdaiClient` uses. `src/context/mapper.ts` turns each response into `ContextBlock`s with real provenance (`source: "memorycore-gateway:/v3/atomic/search"`, `sourceId`, `score`). One consequence worth naming: this is a **fourth** context-data-fetching implementation in the wider system (auto-recall.ts, MemoryProxy's injectors, and now CONTINUUM's client), all hitting the same underlying data through different code — but unlike the first three, this one is the single path any *new* CONTINUUM-integrated caller uses, which is the actual point of "one assembly path."

## 3. `ContextEnvelope` — the canonical representation

```text
ContextEnvelope
├── stable   { blocks: ContextBlock[] }   -- instructions, project-context, persona, scene-index, static-tools
├── dynamic  { blocks: ContextBlock[] }   -- recalled-memory, current-task, recent-conversation, tool-results
└── metadata { sessionKey, query, recallStrategy?, assembledAt, extra? }
```

Two deviations from a literal reading of the brief's target shape, both justified by source evidence:

1. **Block arrays, not two strings.** The brief's diagram shows `stable`/`dynamic` as lists of *kinds* of content; a naive implementation would still just concatenate each into one string, exactly what `auto-recall.ts` does. `MemoryProxy/src/injection/types.ts`'s own `ContextBlock`/`SemanticSlot` design — read while investigating R-16 — already proved that a system with a Token Manager needs to trim *individual* pieces of content, not regex-hack a blob. `ContextBlock` (`src/context/types.ts`) carries `id`, `class`, `content`, `priority` (trim order), and required `provenance` (`source`, optional `sourceId`/`score`, `fetchedAt`) — every block is traceable, not just present.
2. **`scene-index` as its own stable class**, alongside the brief's four (`instructions`/`project-context`/`persona`/`static-tools`). `auto-recall.ts` injects L2 scene navigation as its own segment, distinct from L3 persona — different provenance, different trim priority (scene-index is more expendable than persona in the Token Manager's default ordering, see `mapper.ts`). Collapsing it into "persona" would have lost a real distinction the source system itself makes.

**Deterministic ordering** (`src/context/ordering.ts`): fixed class-priority sequence, then provenance score descending, then id — total, not partial, ordering. This isn't cosmetic: prompt-cache prefix stability (§ Cache report) depends on the *same* input blocks always serializing to the *same* bytes regardless of fetch order (recall results, especially, don't arrive in a stable order across calls).

**One assembly path, enforced, not just documented**: `buildContextEnvelope()` (`src/context/envelope.ts`) is the only function that produces a `ContextEnvelope`. Caller-supplied blocks are validated against a fixed class allowlist (`instructions`/`project-context`/`static-tools` for stable, `current-task`/`recent-conversation`/`tool-results` for dynamic) — a caller literally cannot construct a `persona` or `recalled-memory` block and have it accepted; those three classes may only originate from the `memoryCore` input. This is the enforcement mechanism behind "provider adapters/callers consume/render the result rather than owning recall logic," not just a naming convention.

## 4. Provider rendering (`src/rendering/`)

`renderContextForProvider(envelope, adapter)` branches on `capabilities.protocol` — the same principle Phase 3's `buildAuthHeaders()` established (branch on capability/kind, never on provider identity; `adapter.profile.id` does not appear anywhere in this module). For `anthropic-messages`, each stable block becomes its own content block in the `system` array (verified wire shape — Phase 3's own `AnthropicLLMRunner` tests confirmed `system` is `[{type:"text", text}]`, not a raw string), so a `cache_control` marker can attach to the exact block Anthropic's API expects it on. For `openai-compatible`, stable blocks join into one string — that protocol has no per-block cache concept, so there's no reason to preserve block boundaries. Both providers see **identical selected content**; only serialization differs (tested directly: `render.test.ts`'s last case re-joins Claude's block array and asserts it equals DeepSeek's joined string).

## 5. `StandaloneLLMRunner` token-usage fix (Tencent repo)

Re-verified the Phase 3 finding before touching anything: `MemoryCore/src/adapters/standalone/llm-runner.ts` read `result.usage.promptTokens`/`.completionTokens` from the Vercel AI SDK's `generateText()` result. On `ai@^6.0.164` (this repo's pinned version), `LanguageModelUsage`'s real fields are `inputTokens`/`outputTokens`/`totalTokens` — confirmed by reading `node_modules/ai/dist/index.d.ts` directly, not inferred. The old field names simply don't exist on that object, so `lastUsage` silently reported `{promptTokens: 0, completionTokens: 0, totalTokens: 0}` on every real call.

**Fix, kept narrow per the brief:** two lines changed (`result.usage.inputTokens` / `.outputTokens` instead of the old names). `LLMUsage`'s own field names (`promptTokens`/`completionTokens`/`totalTokens` — MemoryCore's stable public contract, read by `MetricTrackingRunner` and reporting infra elsewhere) are unchanged; only the source read was wrong. Nothing else in `llm-runner.ts` touched. Five new regression tests (`__tests__/llm-runner.test.ts`, mocked fetch, real `@ai-sdk/openai` request/response handling) — including one that asserts non-zero usage is never silently reported as zero, which is the exact shape the original bug took.

## 6. Native Claude harness (`src/native-claude/`) — closing R-17 without touching the launcher

`assembleNativeClaudeContext()` chains `fetchStableFromMemoryCore`/`fetchDynamicRecallFromMemoryCore` → `buildContextEnvelope` → `allocateBudget` (against Claude's context window) → `renderContextForProvider` (Claude adapter) — the exact same pipeline any other integration would use, fed real MemoryCore recall, producing an Anthropic-shaped system-block array + user-prefix string. This is a **harness**, deliberately not wired into `windows/launch-tencent-claude.ps1` (the Phase 4 hard boundary rules out "production launcher rewrite"). Verified against the real, live MemoryCore Gateway, not just mocks — see `PHASE_4_VERIFICATION.md` §5 for what that live call did and didn't prove.

## 7. What was deliberately not built

Per the hard boundary: no Gemini, no agent handoff, no durable session/task-state store (the cache invalidation tracker's per-session hash map is explicitly documented as non-durable, in-memory-only — see `src/cache/invalidation.ts`'s doc comment — matching `LocalStateBackend`'s own known non-durability rather than building something more persistent), no MCP, no local models, no UI, no launcher rewrite, no Health/Recovery consolidation, no Docker rewrite, and no broad MemoryCore refactor (the token-usage fix is two lines in one file). `PHASE_5_ENTRY_CRITERIA.md` documents what this phase's work revealed as candidates for these, without building any of them.
