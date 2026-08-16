# Phase 12 — Isolation-Preserving Capture: Complete

## Pre-work
- Committed Phase 11 cleanly as `05c5a0a` (explicit files, secret-scanned, not pushed).
- Read Phase 10/11 reports + the MemoryCore capture chain source first.

## Authorized scope
This is a **bounded MemoryCore change** (authorized this phase) plus a small CONTINUUM
body-field update. No redesign; the extraction pipeline already supported team/agent
scoping at its `notifyConversation` boundary — it was the v1 `/capture` chain that
dropped the isolation before it got there.

## The root cause (precise)

The v1 `/capture` chain was isolation-blind by design:
- `CaptureRequest` (`gateway/types.ts`) declared `user_id?` only; `handleCapture` ignored even it.
- `CompletedTurn` (`core/types.ts`) had no `teamId`/`userId`/`agentId`.
- `performAutoCapture` (`core/hooks/auto-capture.ts`) took only `sessionKey`/`sessionId`,
  stamped them (and nothing else) onto the L0 record, and called
  `notifyConversation(sessionKey, [])` with no isolation.
- The L1 runner groups L0 messages by `(userId, agentId, sessionId)` and passes those to
  `extractL1Memories` — so extracted atoms inherited the empty/default bucket.

Meanwhile `StatefulPipelineManager.notifyConversation` **already accepts** `teamId`/`agentId`
(params 5–6), and the service-mode `/v3` path already threads them (`server.ts:968`). Only
`/capture` didn't.

## MemoryCore changes (6 files, smallest necessary)

Thread `teamId + userId + agentId` through the existing chain, all fields **optional** for
backward compatibility:

1. `core/types.ts` — `CompletedTurn` gains `teamId?`/`userId?`/`agentId?`.
2. `gateway/types.ts` — `CaptureRequest` gains `team_id?`/`agent_id?` (had `user_id?`).
3. `gateway/server.ts` — `handleCapture` passes `body.team_id/user_id/agent_id` into the turn.
4. `core/tdai-core.ts` — `handleTurnCommitted` forwards `turn.teamId/userId/agentId` into `performAutoCapture`.
5. `core/hooks/auto-capture.ts` — `performAutoCapture` accepts + destructures the three ids,
   stamps them onto the L0 record, passes `userId`/`agentId` to `recordConversation` (JSONL), and calls
   `scheduler.notifyConversation(sessionKey, [], undefined, undefined, teamId, agentId)`.
6. `utils/pipeline-manager.ts` — legacy `MemoryPipelineManager.notifyConversation` signature
   widened with optional trailing `_instanceId/_rounds/_teamId/_agentId` (ignored), so the
   runtime `StatefulPipelineManager` receives them without a second code path.

No new types or protocol — all fields already existed on the types and the pipeline.

## CONTINUUM changes (2 files)

`src/context/memorycore-write.ts` — `captureTurn` now includes `team_id`/`user_id`/`agent_id`
in the `/capture` body (from `cfg.teamId/userId/agentId`; omitted fields fall back to the
default bucket). Test updated to assert the three fields are sent. `memory_capture` already
delegates to `captureTurn`, so the MCP verb inherits isolation automatically.

## Live verification (disposable identities)

Patched the running standalone container in place (baked `/app/src` runs via `tsx`, so the
6 files were `docker cp`'d in and the container restarted; originals backed up under
`/app/.phase12-backup/`). Gateway came back `healthy`, HTTP 200.

**Isolation — extracted L1 cannot cross boundaries (raw `/capture`):**
- Identity A (`team-A/user-A/agent-A`) captured 3 turns → 1 L1 atom `team=team-A user=user-A agent=agent-A`.
- Identity B (`team-B/user-B/agent-B`) → **0** hits.
- same-team different-user → **0**; same-team different-agent → **0**.

**Isolation — through CONTINUUM's own `captureTurn`:**
- `captureTurn` (team-CA) → recall 1 atom; `fetchDynamicRecallFromMemoryCore` (team-CB) → **0**.

**Backward compatibility:** `/capture` with no isolation fields still works
(`l0_recorded`, `scheduler_notified: true`), landing in the default bucket exactly as before.

## Remaining limitation

`recordConversation` (the JSONL fallback path) accepts `userId`/`agentId` but not `teamId` —
its signature never carried it. Team scoping is fully present on the **production SQLite DB
path** (the inline `l0Record` + `queryL0GroupedBySessionId`, which is what the L1 runner reads
when the store is available). The JSONL fallback remains `team`-blind; it only matters when the
vector store is degraded/unavailable. Logged, not fixed (would expand `recordConversation`'s
surface beyond "smallest change"; no production impact in this `storeBackend: sqlite` deployment).

## Tests / health

- CONTINUUM: 281/281 tests + typecheck green (captureTurn asserts the isolation triple now).
- MemoryCore: **no capture-path unit tests exist** in the repo (the only 2 test files are
  LLM-runner tests, unrelated); the container image strips `__tests__/`, and the host has no
  `node_modules`, so neither side can run the suite in this environment. The change is verified
  by the **live isolated end-to-end test** above, which exercises the actual changed code path.
- Tencent `tdai-proxy` / `-hub` / `-core` all `Up (healthy)` (core restarted once to load the
  change, healthy after ~12s).

## Cleanup

All disposable L1 atoms deleted (team-A: 1, team-CA: 1, default-bucket legacy: 2; verified 0
across team-A/B/CA/CB). Residual v1 L0 records use `l0_…` ids that don't delete cleanly via
`/v3/conversation/delete` (same known v1-path artifact as Phases 10–11) but contain no
cross-identity leak. Container source backup retained at `/app/.phase12-backup/` for rollback.

## Remaining risks

1. **`/capture` L0 `team_id` in JSONL fallback** (above) — team-scoping gap only on the
   degraded JSONL path.
2. **Deployment is image-baked, not source-mounted.** My in-place container patch is live but
   not reflected in the `agentmemory/memory-core:latest` image; a fresh `pull_image`/recreate
   would revert it. The fix must be baked into a rebuilt image for durability — a deploy task,
   not a code task.
3. **No automated MemoryCore regression test** covers the capture path; verification is
   live-only until such a test is added.

## Phase 13 recommendation

1. **Fold into a rebuilt image.** The MemoryCore change is live via in-place patch but needs a
   rebuilt + re-published `memory-core` image to survive restarts/pulls.
2. **Add a MemoryCore capture-path unit test** (isolated `/capture` → L1 scoping) so future
   changes don't regress isolation silently — currently zero test coverage there.
3. Optionally extend `recordConversation` to carry `teamId` for full JSONL-path parity.

No further isolation-preservation work is open at the code level; embeddings remain out of scope.

## State
- Committed: Phase 11 `05c5a0a` (plus Phases 6–10 from prior sessions).
- Uncommitted: CONTINUUM `src/context/memorycore-write.ts` + `memorycore-write.test.ts` + this
  doc; MemoryCore 6 files (in a working tree that already had 823 pre-existing modifications).
- Not committed, not pushed. STOP.
