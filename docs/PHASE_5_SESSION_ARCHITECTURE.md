# Phase 5 — Durable Session State: Architecture

**Scope:** a durable, versioned `TaskSession` model and the explicit APIs to update it during work — the operational-continuity layer Agent Handoff (`docs/PHASE_5_HANDOFF_REPORT.md`) builds on. No Gemini, MCP, UI, launcher rewrite, local models, or Health/Recovery.
**Repo touched:** `CONTINUUM` only — this phase made zero Tencent-repo changes (`git status` confirmed identical before/after; see `PHASE_5_VERIFICATION.md` §3).
**Date:** 2026-08-16.

---

## 1. What Session State is (and isn't)

Phase 1's R-18 finding: "no agent-handoff mechanism exists — continuity is whatever landed in async L0-L3 capture, which per R-17 may be nothing." `CONTINUUM_ARCHITECTURE.md`'s own Refinement 2 anticipated exactly this split before any code existed: *memory-pipeline state* (buffers, extraction triggers — MemoryCore's own `IStateBackend`) is one thing; *agent/task session state* (active provider, working directory, open task, decisions, conversation-position cursor) is a different, genuinely missing layer. Phase 5 builds the second one:

```text
Session State                          Tencent Memory
= immediate operational continuity      = long-term knowledge/history
= this task, right now                  = everything that's ever happened
= durable JSON on local disk            = MemoryCore's L0-L3 pipeline
= src/session/                          = src/context/ (Phase 4)
```

A handoff (Phase 5's other half) *may* pull Tencent Memory through the Context Manager, but Session State itself never depends on it — `TaskSession` has its own `completedWork`/`remainingWork`/`importantDecisions`/`relevantFiles` fields, populated by explicit calls during work, independent of whatever L0-L3 has or hasn't captured yet.

## 2. `TaskSession` schema

```text
TaskSession
├── schemaVersion, sessionId, revision       -- versioning + optimistic concurrency (§4)
├── projectId, workingDirectory
├── activeProvider  { providerId, model }     -- Phase 3 ProviderRef shape, reused directly
├── taskGoal, status
├── completedWork[] / remainingWork[]          -- WorkItem { id, description, recordedAt }
├── importantDecisions[]                        -- DecisionRecord { id, decision, rationale?, recordedAt }
├── relevantFiles[]                               -- FileRef { path, note?, recordedAt } -- de-duped by path
├── recentToolActivity[]                           -- bounded ring buffer, most recent 20 (see manager.ts)
├── contextEnvelope?                                -- a Phase 4 ContextEnvelope snapshot, in full
├── cacheMetadata?  { stablePrefixHash?, checkedAt? }
├── git?            -- GitFingerprint (§3)
├── createdAt, updatedAt
└── lastHandoff?    -- HandoffMetadata { handoffId, fromProvider, toProvider, at }
```

Two deviations from the brief's target shape, both justified:

1. **`contextEnvelope` stores the full snapshot, not a reference.** The brief lists "ContextEnvelope snapshot/reference" as one item; a bare reference (e.g. a session key pointing at Phase 4's in-memory `PrefixStabilityTracker`) would be useless after a restart — that tracker is explicitly non-durable. Storing the actual last-assembled envelope is what makes the handoff flush's "fall back to the last snapshot when Tencent recall is delayed" (§`PHASE_5_HANDOFF_REPORT.md`) and the new per-block cache diff (§5) both work.
2. **`recentToolActivity` is a bounded ring buffer (20 entries), not an unbounded list.** The brief doesn't specify a bound, but combined with "do not dump entire conversation history blindly" (stated for handoff, but the same spirit applies to session storage), an unbounded activity log would eventually make every session file, and every handoff built from it, grow without limit.

## 3. Git/worktree fingerprinting

`captureGitFingerprint()`/`compareGitFingerprints()` (`src/session/git-fingerprint.ts`) are modeled directly on `windows/Add-TencentProject.ps1`'s `Get-ProjectFingerprint`/`Compare-ProjectFingerprint` — a genuinely good, already-validated pattern per `TENCENT_MIGRATION_MAP.md` ("generalize into a reusable guard-rail component for any CONTINUUM operation that touches a user's project folder"). Read directly from that PowerShell source before writing this: it captures git remote/branch/HEAD SHA plus recursive file counts, and treats missing fields as "can't compare" rather than "changed." This module keeps remote/branch/HEAD, adds `dirty`/`changedFileSummary` (the brief asks for them; the PowerShell original doesn't check dirty-state, having been written for a different purpose — pre/post-registration safety, not resume staleness), and drops the file-count check (not applicable here).

**Every git command this module runs is read-only**: `rev-parse`, `branch --show-current`, `status --porcelain`, `remote get-url`. Nothing resets, stashes, or checks out anything — per the brief's explicit "Do not automatically reset/stash/checkout."

**A deliberate asymmetry in staleness detection**: dirty-state alone (clean → dirty) is *not* flagged as staleness on its own — that's what normal, continuing work looks like. It only contributes a reason once something else (branch or HEAD) has already changed, which is the actual signal that *independent* work happened rather than the same agent continuing to edit. See `compareGitFingerprints`'s tests for the exact boundary.

## 4. Durability

**Backend**: one JSON file per session, `<baseDir>/<sessionId>.json` (`FileSessionStore`, `src/session/store.ts`) — per the brief's "use a simple local durable backend first... do not over-engineer distributed state." No database, no Redis, nothing session-state-specific added to the already-running Tencent stack.

**Atomic writes** (`src/session/atomic-file.ts`): write to a uniquely-named temp file in the same directory (guarantees the final `rename()` is atomic on the same filesystem), `fsync` before closing, copy the *current* file to `.bak` before overwriting (best-effort — a missing current file, i.e. first save, is fine), then rename the temp file over the target. A reader never observes a partially-written file.

**Corruption detection/recovery**: every write stores a SHA-256 checksum computed over the *canonical* (recursively key-sorted — `canonical-json.ts`) form of the data, alongside the data itself. A read verifies the checksum; on mismatch, falls back to `.bak`; if both fail, throws `SessionCorruptionError` rather than silently returning a default/empty session (which would hide real data loss).

**Schema versioning**: `TaskSession.schemaVersion`, checked on every load via a `migrate()` function (`store.ts`) that's currently an identity transform for the only version that exists (`SESSION_SCHEMA_VERSION = 1`) — the extension point future versions hook into. A stored version *newer* than the running build supports throws `UnsupportedSchemaVersionError` rather than guessing at a downgrade.

**Optimistic concurrency ("do not overwrite newer work")**: `TaskSession.revision` is a monotonically increasing counter. `SessionManager`'s every update method loads the current session, computes the new state, and saves with `expectedRevision` set to what it loaded — `FileSessionStore.save()` checks the file *currently on disk* still has that exact revision before writing, and throws `SessionConflictError` otherwise. This is a real, tested property (`store.test.ts`'s conflict test), not just a documented intention.

## 5. Explicit, incremental state-capture APIs

`SessionManager` (`src/session/manager.ts`) has one method per kind of update — `addCompletedWork`, `addRemainingWork`, `completeWorkItem`, `recordDecision`, `recordRelevantFile`, `recordToolActivity`, `setActiveProvider`, `updateContextEnvelopeSnapshot`, `updateGitFingerprint`, `setStatus` — each a load → mutate-one-field → save-with-concurrency-check → return-new-state round trip. This is the direct mechanism behind "state must update during work, not only at session end": there's no single big `setState()` to defer until later, and each call names exactly what changed.

## 6. Precise cache-invalidation diffing (`src/cache/block-diff.ts`)

Phase 4's `PrefixStabilityTracker` could only report "the stable prefix changed" — it retained a hash, not the previous envelope, so it couldn't say *which* block changed (a documented limitation at the time, `PHASE_4_CACHE_TOKEN_REPORT.md` §2). Session State's durable `contextEnvelope` snapshot is exactly the missing ingredient: `diffStableBlocks(previous, current)` compares two block lists by id and per-block content hash, reporting `added`/`removed`/`modified`/`unchanged` for each — built *because* session storage now makes the previous envelope available, per the brief's "implement this only if it fits naturally into session storage." Deliberately narrow: a diff of one stable section against another, nothing tracked over time, no aggregate stats — "do not expand into general analytics."

## 7. What was deliberately not built

No distributed backend (single local JSON file per session, as instructed). No new mutating git operations. No launcher integration — nothing in `src/session/` is wired into `windows/launch-tencent-claude.ps1`. See `docs/PHASE_6_ENTRY_CRITERIA.md` for what this phase's work revealed as candidates for later phases.
