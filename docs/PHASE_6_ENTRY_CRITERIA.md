# Phase 6 Entry Criteria

Phase 5 (Durable Session State + Agent Handoff Prototype) is closed — see `PHASE_5_SESSION_ARCHITECTURE.md`, `PHASE_5_HANDOFF_REPORT.md`, `PHASE_5_VERIFICATION.md`. This lists what's satisfied, what Phase 5 revealed (documented only, per the hard boundary — nothing below was built), and decisions needed before Phase 6 starts.

## Satisfied

- [x] Durable, versioned `TaskSession` — atomic writes, checksum + `.bak` corruption recovery, optimistic-concurrency conflict detection, all tested with a real simulated process restart and real corrupted files.
- [x] Explicit, incremental state-capture APIs — state updates during work, not only at session end.
- [x] Synchronous handoff flush that provably does not block on Tencent memory (tested against a `fetch` that never resolves).
- [x] Token-budgeted, context-aware handoff packages through the real Phase 4 Token Manager.
- [x] Claude ↔ DeepSeek handoff proven both directions through the identical mechanism; same-provider restart proven through the same mechanism too.
- [x] Explicit, non-automatic receiving-provider selection through the real Phase 3 Provider Registry.
- [x] Stale git/worktree detection, surfaced directly in the receiving agent's own rendered context.
- [x] Precise per-block cache-invalidation diffing, now that session storage durably retains the previous envelope.
- [x] 164 (CONTINUUM) + 13 (MemoryCore) + 54 (MemoryProxy) tests passing; live Tencent stack healthy throughout; zero Tencent-repo changes this phase.
- [x] Phase 4 baseline committed in both repos (`b1e189d` Tencent, `0b57a95` CONTINUUM); Phase 5 itself left uncommitted, as instructed.

## What Phase 5 revealed (documented only — none of this was built, per the hard boundary)

1. **No history of past handoffs.** `TaskSession.lastHandoff` holds only the single most-recent transfer. If a task changes hands three times, only the last hop is recorded — earlier ones are gone once overwritten. Worth a small, deliberate follow-up (an append-only `handoffHistory[]`, bounded like `recentToolActivity`) if multi-hop handoff auditing ever matters; not built here since nothing in this phase's scope needed it.
2. **No session retention/cleanup policy.** `FileSessionStore` never deletes anything on its own — old, completed, or abandoned sessions accumulate on disk indefinitely. Not a correctness problem yet (JSON files are small), but a real operational gap once this is used for real, ongoing work across many tasks.
3. **Codex still isn't in the Provider Registry** (unchanged since Phase 3/4) — so handoff *to* Codex isn't possible yet, independent of anything Phase 5 built. Stated plainly, not silently absent.
4. **Handoff was verified end-to-end with mocked MemoryCore data, not a live non-empty recall** — the same caveat Phase 4's native-Claude harness carried (`PHASE_4_VERIFICATION.md` §5): a live run against the real Gateway with a synthetic identity would again likely return empty results. A combined live-verification effort (real seeded test identity, covering both the Phase 4 harness and Phase 5's handoff flush) is a reasonable single follow-up rather than two separate ones.
5. **No launcher integration for the "ask the user which agent takes over" prompt.** `HandoffManager`'s two-call API is a real, tested enforcement mechanism, but nothing surfaces it interactively in `windows/launch-tencent-claude.ps1` — deliberately, per the hard boundary. A cross-platform launcher (already flagged as lower-priority in `CONTINUUM_ARCHITECTURE.md`'s original sequencing) would be the natural place to wire this in.
6. **Session state is single-machine, single-process-at-a-time by construction.** The optimistic-concurrency check prevents silent overwrites *within* a single `FileSessionStore` directory, but there's no cross-machine or cross-process-group coordination (file locks, leases) — fine for the brief's explicit "do not over-engineer distributed state," but worth naming as a real limitation if CONTINUUM is ever used from more than one machine against the same session directory.

## Decisions needed from you before Phase 6 starts

1. **Which Phase 6 direction?** Two independent candidates, per the original Phase 2 sequencing and this phase's own findings: **MCP wrapper around MemoryCore's Gateway API** (never built, independent of everything since Phase 2, can run in parallel with anything) — or continuing the session/handoff line with **session retention policy + handoff history** (small, but real operational gaps found this phase).
2. **Pursue the combined live-verification follow-up (item 4 above)?** Needs either a disposable seeded MemoryCore identity or real user data access, same tension flagged in `PHASE_4_ENTRY_CRITERIA.md`'s item 1 — still not resolved, now applies to two harnesses instead of one.
3. **Gemini/Codex/local-model providers — build now or stay at 2?** Unchanged recommendation from `PHASE_4_ENTRY_CRITERIA.md`: still no concrete need identified: defer until one exists.

## Recommended Phase 6 starting point

**MCP wrapper around MemoryCore's Gateway API** — per `PHASE_2_RECOMMENDATIONS.md`'s original item 3, it has been "independent, can run in parallel with everything else" since before Phase 3 even started, and nothing in Phases 3-5 changed that. It also stands on its own two feet regardless of which other direction (session retention, live verification, more providers) gets picked up alongside it.
