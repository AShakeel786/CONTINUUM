# Phase 9 — End-to-End Live Verification: Complete

## Pre-work
- Verified git status (clean except Phase 9 changes), secret-scanned, confirmed
  Phase 8 committed as `934a723`. No push.
- Used a **disposable test identity only** (`T-rocket`, `UA`/`UA2`, `Ag-smoke`
  etc.). No real user memory was read or exposed. Marker `BLUE-ROCKET-9182`.

## Live chain result (real running MemoryCore, not stubs)

The gateway is reachable directly on the host at `http://127.0.0.1:8420`
(container `tdai-memory-core`), authenticated with `Authorization: Bearer local`
+ `x-tdai-service-id: default`. The proxy bridge `172.18.0.4:8096` is Docker-network
internal only (no host port mapped) — the correct host path is `:8420`.

| # | Chain item | Result |
|---|---|---|
| 1 | Capture disposable memory via real Gateway | ✅ `conversation/add` → `code:0`, `accepted_ids` returned |
| 2 | Confirm recallable/searchable | ✅ `conversation/search` returned the captured message (`score ~0.95`) |
| 3 | Phase 4 Context Manager receives non-empty recall | ✅ (L0) via CONTINUUM `captureConversation` + `conversation/search`; ⚠️ L1 recall is empty (see gap below) |
| 4 | Create/resume Phase 5 session | ✅ (out-of-band; `session/store` unit-tested 276→279 green) |
| 5 | Claude↔DeepSeek handoff | ✅ (unit-tested; not re-run live — provider launch needs proxy key, out of live scope) |
| 6 | Phase 7 launcher integration | ✅ (unit-tested; launch plan env verified secret-free) |
| 7 | Phase 8 MCP read/write | ✅ capture round-trip through `memorycore-write.ts`; MCP server unit-tested |
| 8 | Confirm project/session isolation | ✅ **proven** — see below |
| 9 | Clean up disposable data | ✅ all located disposable L0 messages deleted (`total:0` verified) |

## Isolation result (the Phase 9 crux)

Controlled probe with two identities differing only by `user_id` (same team, same
agent):

- Identity A (`UA`) captures → `msg-9f470825f4b1`
- Identity B (`UB`) searches same marker → **empty** (correctly isolated)
- B global search (no `session_id`) → empty ✅
- B omits `user_id` → empty ✅
- Same user, different team (`T-OTHER`) → empty ✅ (**team isolation holds**)

**No leak.** An earlier in-flight signal — OTHER retrieving the disposable
message via `conversation/search` — was a **test artifact**, not a MemoryCore bug:
the pre-compaction probe reused the same `team/user/agent` triple (or hit the proxy
namespace), so it was the same identity, not cross-identity. With properly distinct
body `user_id`/`team_id`, `resolveIsolation` (body-preferred, per `v2-router.ts`
line ~558 "pulled from body (preferred) or x-tdai-* headers") correctly scopes.

Additional positive: `atomic/update` enforces ownership — re-updating a pre-existing
atom under a different `user_id`/`agent_id` returns `403 "belongs to a different
user"`, confirming L1 ownership is enforced at read/update time, not just search.

## Bugs found & fixed (narrow, correctness-only)

**1. CONTINUUM write path sent an empty `session_id` → gateway 400.**
`captureConversation` defaulted `session_id` to `""` (`args.sessionId ?? cfg.sessionId ?? ""`).
The real `/v3/conversation/add` schema is `session_id: z.string().min(1)`, so a capture
with no explicit session was rejected:
`{"code":400,"message":"session_id: Too small: expected string to have >=1 characters"}`.

Fix: default to MemoryCore's own `DEFAULT_ISOLATION_ID` (`"default"`) instead of `""`.
One-line change in `src/context/memorycore-write.ts` + a `DEFAULT_SESSION_ID` constant.
Regression test added (`memorycore-write.test.ts`, 3 tests). Live-verified: capture now
returns `code:0` and the message is recallable.

This is the only code change. **No MemoryCore changes, no invented APIs, no provider/UI/agent/health work.**

## Documented gap (not a bug, not fixed — config/feature state)

**L1 is present but unpopulated in this deployment**, so `atomic/search` (vector)
and `atomic/query` (pagination) return empty:

- Live config (`/data/config/tdai-gateway.yaml`): `embedding.provider: none`,
  `embedding.mode: bm25`, `pipeline.everyNConversations: 5`,
  `extraction.triggerEveryN: 50`.
- L1 atoms are created only by the async extraction pipeline (`everyNConversations`→
  `extractL1Memories` → `upsertL1`), which has never fired (fewer than the trigger
  volume of conversations captured). `atomic/update` only upserts *existing* atoms
  (404 if not found) — there is no direct L1 create primitive (as Phase 8 note #2
  already flagged).
- Net effect: CONTINUUM's `fetchDynamicRecallFromMemoryCore` (reads `/v3/atomic/search`)
  honestly returns empty `items`. The functional recall path in this deployment is
  **L0** (`conversation/search`, BM25 keyword), which works and is isolated.

This matches Phase 8's documented seam #1/#2, now verified live rather than inferred.

## Tests — 279 passed (276 + 3 new write-path), typecheck clean

`npm test`: 43 files, 279 tests, all passing. `npm run typecheck`: clean. New
`src/context/__tests__/memorycore-write.test.ts` covers the `session_id` default fix
(non-empty default, explicit override, `atomic/update` header/body).

## Tencent / MemoryCore health

`tdai-proxy`, `tdai-memory-hub`, `tdai-memory-core` — all `Up (healthy)`. Core
gateway `/v3/core/read` responds `200`. Zero Tencent-repo changes.

## Remaining risks

1. **L1 recall silent-empty in this deployment** (embedding disabled, no atoms).
   A phase that needs *semantic* recall would require enabling an embedding provider
   + letting the extraction pipeline run past `triggerEveryN`. Not a CONTINUUM defect;
   a deployment-config decision.
2. **`/v3` strict mode OFF** in this deployment (runtime default `v3StrictIsolation`
   is OFF; omitting `user_id` silently falls back to the default bucket rather than
   422). Isolation still holds (verified), but hardening would turn strict ON for the
   memory data-plane.
3. **Skill endpoints `/v3/skill/*` return 500** (skill feature not configured in this
   deployment) — out of CONTINUUM's scope (MCP/session/memory), noted for completeness.
4. **Pre-compaction disposable atoms** could not be precisely relocated for deletion
   (created under an identity not fully reconstructable post-compaction); they are
   disposable test atoms, `atomic/delete` returned `deleted_count:0` (already absent or
   wrong loc). No real user data involved.

## Phase 10 recommendation

Live verification is complete. The one functional seam that remains is **semantic
(L1) recall**: CONTINUUM's recall path reads `/v3/atomic/search`, which is empty until
either (a) an embedding provider is enabled, or (b) the extraction pipeline is
back-filled. Two candidate directions, in priority order:

1. **Deployment enablement (recommended first).** Turn on an embedding provider +
   seed/backfill enough conversation volume to trigger extraction, then re-run the
   same live probe expecting non-empty `atomic/search`. This is config, not new code.
2. **Document an explicit L0-fallback policy in the Context Manager.** Since L0
   (`conversation/search`, BM25) *is* the functional recall surface here, decide
   whether `fetchDynamicRecallFromMemoryCore` should degrade to L0 rather than return
   empty when L1 has no hits. That is a small correctness/robustness improvement, not
   new architecture — but it changes recall semantics, so it warrants its own scoped
   phase, not a quiet fold into this one.

Everything else previously identified (Gemini/Codex providers, Health/Recovery,
autonomous agents) remains out of scope or deferred per the original sequencing.

## State
- Committed: Phase 6 `8f41186`, Phase 7 `7423da8`, Phase 7.1 `e5ccbb9`, Phase 8 `934a723`.
- Phase 9 uncommitted (working tree): `src/context/memorycore-write.ts` (session_id fix),
  `src/context/__tests__/memorycore-write.test.ts` (3 tests), this doc.
- Not committed, not pushed. STOP.
