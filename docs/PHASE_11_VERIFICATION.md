# Phase 11 — Memory Capture Path Alignment: Complete

## Pre-work
- Committed Phase 10 cleanly as `9706aa0` (explicit files, secret-scanned, not pushed).
- Read Phase 10 report/code first. Disposable identity only (`default/default/default`
  + `phase11-session-1`, marker `BLUE-ROCKET-9182-phase11`). No real user memory read
  or exposed.

## Problem

CONTINUUM had one memory *write* primitive — `captureConversation` → `/v3/conversation/add`
— used by MCP `memory_capture`, and its doc claimed "triggers L1 extraction." Phase 10
proved that claim false in standalone: `/v3/conversation/add` writes L0 only and does
NOT fire the extraction pipeline there (the `notifyPipeline` hook is service-mode only).
The path that *does* trigger L0→L1→L2→L3 is v1 `POST /capture`.

## What changed (path alignment)

Investigated all write call sites: only `src/context/memorycore-write.ts` (primitives)
and `src/mcp/memory-tools.ts` (MCP handlers) write to MemoryCore. Launcher/session/handoff
flows only *read* (or use git-fingerprint, unrelated). Scope was therefore narrow.

| Primitive | Endpoint | Semantics | Who uses it |
|---|---|---|---|
| `captureTurn` (new) | `POST /capture` (v1) | High-level "commit a turn" → triggers async L0→L1→L2→L3 pipeline. Scoped by `session_key` only (team/user/agent → gateway default bucket). | MCP `memory_capture` |
| `captureConversation` (kept) | `/v3/conversation/add` (v3) | Low-level "append isolated L0 messages." Honors team/user/agent; **no** extraction trigger in standalone. | none now; available for explicit-isolation use |
| `updateAtomicMemory` | `/v3/atomic/update` | L1 upsert-by-id (unchanged). | MCP `memory_store_atom` |
| `writeCoreMemory` | `/v3/core/write` | L3 persona write (unchanged). | — |

Changes:
- `src/context/memorycore-write.ts`: added `captureTurn` (+ `CaptureTurnResult`), which
  POSTs `{ user_content, assistant_content, session_key }` to `/capture` and unwraps the
  raw v1 body (`{ l0_recorded, scheduler_notified }`, NOT the `/v3` envelope). Corrected
  the `captureConversation` doc comment (no longer claims extraction). Header/doc updated
  to distinguish the two capture paths explicitly.
- `src/mcp/memory-tools.ts`: `memory_capture` now takes `{ user_content, assistant_content,
  session_key? }` and calls `captureTurn` (was `{ role, content }` → `captureConversation`).
- Tests: `memorycore-write.test.ts` +2 (`captureTurn` URL/body/shape, session fallback).

No MemoryCore logic duplicated — extraction stays entirely inside MemoryCore; CONTINUUM
only switches *which supported endpoint* its capture verb hits.

## Documented distinction

- **`memory_capture` (high-level, pipeline-triggering)**: commit a completed user+assistant
  turn → `POST /capture` → L0 record → async extraction → L1/L2/L3. This is what "capture
  new memory" should mean. Caveat: v1 `/capture` scopes by `session_key` only; the
  `x-tdai-team/user/agent-id` isolation dimensions fall back to the gateway default bucket
  (a MemoryCore v1 limitation, not a CONTINUUM choice).
- **`/v3/conversation/add` (low-level, isolated L0 write)**: append arbitrary messages with
  full team/user/agent isolation, but no extraction. Use only where explicit multi-dim
  isolation or raw message control is the actual requirement — not for normal capture.

## Live chain (proven with disposable data)

`captureTurn` → L0 → L1 extraction → `atomic/search` (BM25) → ContextEnvelope, all through
CONTINUUM's own code:

```
CAPTURE_TURN: {l0Recorded: 2, schedulerNotified: true}   (per turn)
RECALL_L1: 2
  [episodic] 用户（CAR 525用户）需要了解CAR 525章节中关于燃油系统的要求
  [episodic] 用户（CAR 525用户）需要记忆CAR 525章节中关于疲劳和损伤容限的要求
```

- First capture of a *new* session records only `l0Recorded: 1` (MemoryCore cold-start
  cursor filters the first user message) — this is upstream behavior, not a CONTINUUM bug;
  subsequent captures record 2.
- L1 extraction fires after the warmup threshold (`enableWarmup: true`, `everyNConversations: 5`);
  a brand-new session needs a few rounds before its first extraction — confirmed in the
  core logs (`L1 complete: extracted=2, stored=2`). L2/L3 (persona/scene) are later
  pipeline stages (L2 `delayAfterL1Seconds: 90`, L3 `triggerEveryN: 50`) and do not fire
  for a short disposable session — already proven working in Phase 10.

## MCP result

`memory_capture` now surfaces the high-level capture verb: input `{ user_content,
assistant_content, session_key? }`, output `{ l0_recorded, scheduler_notified }`. This
matches "capture new conversation/memory" intent (triggers extraction). `memory_search` /
`memory_recall` / `memory_store_atom` unchanged.

## Isolation

Re-verified: owner (`default`) sees the disposable L1 atoms; OTHER identity
(`T-OTHER/OTHER-user/OTHER-agent`) sees 0. No leak. The `/capture`-scoped-by-session-key
caveat (team/user/agent → default bucket) is the one isolation nuance introduced by
switching to `/capture`, and is documented rather than papered over.

## Tests / Tencent health

- CONTINUUM: 281/281 tests, typecheck clean (279 → 281, +2 `captureTurn` tests).
- Tencent `tdai-proxy` / `-hub` / `-core` all `Up (healthy)`.
- **Zero Tencent-repo changes.**

## Cleanup

All disposable Phase 11 data removed and verified: L1 CAR525 atoms `deleted_count: 2`,
L1 `total: 0`, no `phase11-session-1` L0 remaining. Live agent session data
(`ee4010d6-…`) left untouched.

## Remaining risks

1. **`/capture` drops three-dim isolation** (scopes by `session_key` only). If CONTINUUM
   needs team/user/agent-scoped *extraction*, that requires either a MemoryCore-side
   change (extend `/capture` to honor isolation) or accepting the default bucket for
   pipeline-triggered capture. Not addressed here (out of Phase 11 scope).
2. **`/v3/conversation/add` remains extractive-inert in standalone.** Keeping it as the
   documented low-level write means anything writing through it will still not populate L1.
   Currently nothing in CONTINUUM calls it; it's retained as the isolated-write primitive.
3. **Warmup latency** — a new session's first L1 extraction lags the first captures by the
   warmup schedule. If prompt first-turn recall matters, this is a MemoryCore tuning
   (`enableWarmup`/`everyNConversations`), not a CONTINUUM change.

## Phase 12 recommendation

The capture path is now unambiguous. Candidates for the next scoped phase, in priority order:

1. **Isolation-preserving capture (if needed).** If multi-tenant/team isolation of extracted
   memory is a real requirement, drive (or document) a MemoryCore change to let `/capture`
   honor team/user/agent — then have CONTINUUM pass those dimensions. Otherwise accept the
   default-bucket capture as the documented behavior.
2. **Optional cross-lingual embedding** (unchanged from Phase 10) — enable `local`/`openai`
   embeddings for true semantic recall; a cost/dependency decision, not required.

Everything else (providers, UI, autonomous agents, Health/Recovery) remains out of scope.

## State
- Committed: Phase 10 `9706aa0` (plus Phases 6–9 from prior sessions).
- Phase 11 uncommitted (working tree): `src/context/memorycore-write.ts`,
  `src/mcp/memory-tools.ts`, `src/context/__tests__/memorycore-write.test.ts`, this doc.
- Not committed, not pushed. STOP.
