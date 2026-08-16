# Phase 10 — Semantic Memory Enablement: Complete

## Pre-work
- Committed Phase 9 cleanly as `84a7f62` (explicit files, secret-scanned, not pushed).
- Read Phase 9 report + live Tencent config/code before changing anything.
- Disposable identity only (`default/default/default` + `astronaut-session-1`,
  marker `BLUE-ROCKET-9182`). No real user memory read or exposed.

## Root cause of the Phase 9 "L1 gap" (corrected)

Phase 9 reported L1 `atomic/search`/`atomic/query` empty and attributed it to
`embedding.provider: none`. **That attribution was wrong.** The real root cause:

1. **Standalone `/v3/conversation/add` does NOT trigger L1 extraction.** The
   gateway's `v2Deps.notifyPipeline` is wired only inside the service-mode block
   (`if (this.storePool && this.configProvider)` in `server.ts`). In standalone
   mode (`deployMode: standalone`, which this deployment is), `handleConversationAdd`
   writes L0 only, with the explicit comment "Not**ify pipeline: trigger async L1
   extraction (service mode)." So CONTINUUM's Phase 8 capture path
   (`captureConversation` → `/v3/conversation/add`) and MCP `memory_capture`
   ingest L0 but **never populate L1** in standalone.
2. **Extraction is LLM-driven, not embedding-driven.** `extractL1Memories`
   requires an LLM call (DeepSeek, already configured), not an embedding provider.
   Embeddings are only needed for the *vector* recall leg; the **FTS/BM25 leg
   needs no embedding at all**.
3. **The supported extraction trigger in standalone is the v1 `POST /capture`**
   (`handleCapture` → `handleTurnCommitted` → `performAutoCapture` →
   `notifyConversation`), which writes to the **live** store and fires L1→L2→L3
   async. (A separate `POST /seed` / `seed-v2` backfill path exists but writes to
   a *separate seed-output directory*, not the live store.)

## Embedding choice: keep `provider: none` (BM25), do NOT add an embedding provider

Investigated the three supported options in `MemoryCore/src/core/store/embedding.ts` +
`factory.ts`:

| Option | Cost | Dependency | Notes |
|---|---|---|---|
| `none` (BM25 only) | **zero** | none | Standalone default ("默认关闭向量搜索, 仅用 BM25"). Lexical recall. |
| `local` (node-llama-cpp + embeddinggemma-300m) | zero API | ~300MB GGUF download + llama native binding | `node-llama-cpp` is already a declared dep, but model + native binding absent in image; deferred warmup. |
| `openai` (OpenAI-compatible remote) | per-token | apiKey + baseUrl + model + dims | Ongoing cost; DeepSeek chat key may not serve embeddings. |

**Decision:** the standalone design's own default is BM25-only semantic (LLM-extracted
atoms + BM25 recall). Enabling an embedding provider would add cost/dependency for
*the sole benefit of cross-lingual/paraphrase recall*, which is **not required to
satisfy the chain** — L1 extraction + same-language recall already works with zero
added cost. So **no embedding provider was enabled**; this is "configure existing
capability," not redesign. The FTS path (`searchL1Fts` → `l1_fts`) is already the
configured default.

Note: BM25 is **lexical**, not cross-lingual-semantic. English query "corrosion
inspection" over Chinese-extracted atoms returns empty; Chinese keyword query returns
the atoms at score ~0.96. True cross-lingual semantic recall is the one thing an
embedding provider would add, and is documented as a separate, optional follow-up.

## Live L1 result (proven with disposable data)

Single `POST /capture` (2 messages) produced the **full L0→L1→L2→L3 chain**:

- L0: 2 messages recorded (`l0_recorded: 2, scheduler_notified: true`)
- L1: 2 atoms extracted (LLM) — `persona` + `episodic` (Chinese content)
- L2: 1 scene (`航空维修-AME执照备考.md`)
- L3: 1 persona profile (`User Narrative Profile: 航空维修执照考生…`)

`atomic/search` (BM25) over the L1 atoms, Chinese keyword "机身结构 腐蚀检查" →
2 hits at score 0.96/0.96, `strategy: fts`. Empty for English (lexical limitation).

## Context Manager result (CONTINUUM live)

Proved CONTINUUM's Phase 4 Context Manager receives non-empty L1 recall:

```
RECALL_ITEMS: 2
  - [persona] score=0.962 :: 用户（考生）的薄弱领域是机身结构和腐蚀检查程序。
  - [episodic] score=0.958 :: 用户正在准备加拿大AME航空维修执照考试…
ENVELOPE_DYNAMIC_BLOCKS: 2  (class=recalled-memory, provenance set)
```

## Bug found & fixed (narrow, correctness-only)

**CONTINUUM read client did not unwrap the gateway envelope.** `postV3` in
`src/context/memorycore-client.ts` returned `res.json()` — the full
`{ code, message, request_id, data }` envelope — but `fetchStableFromMemoryCore`
and `fetchDynamicRecallFromMemoryCore` consumed it as if it were the inner `data`
payload (`core?.content`, `data.items`). Result: every live read returned empty
(persona `null`, recall `0 items`) while curl against the same endpoints returned
data. The write client already unwrapped correctly, so the read side was the lone
divergence — verified live, not inferred.

Fix: `postV3` now unwraps `envelope.data` (one method, matching `memorycore-write.ts`).
Updated 3 test files that mocked the pre-unwrapped shape (`memorycore-client.test.ts`,
`native-claude/__tests__/assemble.test.ts`, `handoff/__tests__/flush.test.ts`).
**279 tests + typecheck green** (same count as Phase 9; no net test-count change —
the mocks corrected a contract they were wrongly asserting).

## Isolation result

L1 atoms are scoped by team/user/agent like L0. Verified live:
- Owner (`default/default/default`) → 2 atoms
- OTHER identity (`T-OTHER/OTHER-user/OTHER-agent`) → **0** atoms
- Cross-team → 0

No leak. (Same as Phase 9; re-verified against L1 specifically.)

## `v3StrictIsolation` — recommendation: leave OFF (unchanged)

Evaluated `resolveV3StrictIsolation()` (`env-config.ts`): OFF by default, controlled
by `V3_STRICT_ISOLATION=1/true/on/yes`, and it only affects the `/v3` L0–L3
data-plane. Enabling it would 422 any `/v3` request missing `team+agent+user+session`
triple. Compatibility impact: CONTINUUM's read/write clients always send `team_id` +
`user_id` + `agent_id`, but the write path's `session_id` default is `"default"`
(Phase 9 fix) and the read path sends `session_id: cfg.sessionId` (may be `undefined`
→ dropped). Enabling strict would require auditing every CONTINUUM call site to
guarantee a non-empty session_id, and would also affect the v1 `/capture` path that
writes under `default/default/default`. **Not enabled** — isolation already holds
without it (verified), and the compatibility cost is non-trivial. Logged as a
production-hardening follow-up, not a Phase 10 change.

## Costs / dependencies

- **No new dependencies.** `provider: none` (existing default), BM25 FTS (existing),
  LLM extraction (existing DeepSeek config). No embedding API cost, no 300MB model
  download, no llama native binding.
- One LLM call per extraction (~a few messages), the only ongoing cost — same as the
  already-enabled extraction feature.

## Tests / Tencent health

- CONTINUUM: 279/279 tests, typecheck clean.
- Tencent `tdai-proxy` / `-hub` / `-core` all `Up (healthy)`, gateway 200.
- **Zero Tencent-repo changes.** All changes confined to CONTINUUM.

## Cleanup

All disposable data removed and verified empty: L1 `total:0`, L0 `total:0`,
L2 `entries:0`, L3 persona `content_len:0`.

## Remaining risks

1. **Standalone `/v3/conversation/add` still doesn't trigger L1.** CONTINUUM's
   `captureConversation` (Phase 8 MCP `memory_capture`) ingests L0 but does not
   populate L1 in standalone. The working trigger is v1 `POST /capture`. Closing
   this is either (a) a Tencent-side change (wire `notifyPipeline` in standalone),
   which is out of Phase 10 scope, or (b) a CONTINUUM-side decision to route capture
   through `/capture` instead of `/v3/conversation/add` — a semantic change to the
   capture contract, not validated here.
2. **BM25 is lexical only.** Cross-lingual/paraphrase recall requires an embedding
   provider (local or openai). Not chosen for cost/dependency reasons; optional.
3. **`v3StrictIsolation` OFF** (hardening follow-up, see above).
4. **Skill endpoints `/v3/skill/*` return 500** (unchanged from Phase 9; out of scope).

## Phase 11 recommendation

Two independent, well-scoped candidates — neither is a "natural next step" without a
product decision:

1. **Capture-path alignment (recommended first).** Decide whether CONTINUUM's capture
   should route through v1 `POST /capture` (which populates L1 in standalone) instead
   of `/v3/conversation/add` (L0-only in standalone). This is a small, well-understood
   change that would make `memory_capture` → L1 extraction actually work in the current
   deployment. Requires a deliberate contract decision, not a quiet fold.
2. **Optional semantic (cross-lingual) recall.** Enable `local` embedding
   (node-llama-cpp already a dep; needs ~300MB model + native binding in the image) or
   an `openai`-compatible embedding API, then re-run the recall probe expecting
   cross-lingual hits. This is a cost/dependency decision, documented as optional.

Everything else (providers, UI, autonomous agents, Health/Recovery) remains out of
scope per the original sequencing.

## State
- Committed: Phase 9 `84a7f62` (plus Phases 6–8 from prior sessions).
- Phase 10 uncommitted (working tree): `src/context/memorycore-client.ts`
  (envelope unwrap), 3 test files corrected, this doc.
- Not committed, not pushed. STOP.
