# Phase 5 — Agent Handoff Prototype: Report

Companion to `PHASE_5_SESSION_ARCHITECTURE.md`. What was built, how it reuses Phase 3/4 machinery, and exactly what "prototype" means here (a tested harness/API, not a launcher integration).

---

## 1. The flow, as built

```text
Agent A
  ↓
flushHandoff(session, opts)              -- src/handoff/flush.ts
  ↓
HandoffPackage (token-budgeted)
  ↓
HandoffManager.listAvailableReceivingProviders()   -- src/handoff/manager.ts
  ↓
(a human chooses — never automatic)
  ↓
HandoffManager.finalizeHandoff(sessionId, chosenProviderId, opts)
  ↓
renderContextForProvider(...)  -- Phase 4, unmodified
  ↓
Agent B's rendered, provider-shaped context
```

Every arrow after "flush" reuses existing Phase 3/4 code unmodified: provider selection goes through the real `ProviderRegistry` (Phase 3), rendering goes through the real `renderContextForProvider` (Phase 4), budgeting goes through the real `allocateBudget` (Phase 4). Phase 5 adds the session/handoff-specific pieces around that core, not a parallel implementation of any of it.

## 2. "Synchronous" flush, precisely defined

The brief calls for a "Synchronous Handoff Flush... even if Tencent memory extraction has not completed." `flushHandoff()` (`src/handoff/flush.ts`) is an `async` TypeScript function — "synchronous" here means *the handoff's completion does not wait on Tencent's async L0-L3 capture pipeline to catch up*, not "literally blocking JS." Concretely:

1. A best-effort MemoryCore fetch is attempted, **with a short timeout (default 3000ms)** — deliberately short, because a slow Gateway must never stall a handoff.
2. On success: the fresh persona/scene-index/recalled-memory content is used, `tencentMemoryFreshness: "fresh"`.
3. On failure or timeout (caught, never propagated): falls back to the session's own stored `contextEnvelope` snapshot (Phase 5's session state, not Tencent Memory) — `tencentMemoryFreshness: "snapshot"`.
4. If neither is available: the handoff still completes, using only session state (`taskGoal`/`completedWork`/etc.) — `tencentMemoryFreshness: "none"`.

All three cases are exercised in `flush.test.ts` — including one where `fetch` is stubbed to a promise that **never resolves**, to prove the timeout genuinely prevents a hang, not just a documented intention.

## 3. What's in a `HandoffPackage`, and what's deliberately not

Every field maps directly to a bounded, already-existing `TaskSession` field, rendered to a plain string summary — `completedWork`, `remainingWork`, `decisions`, `relevantFiles`, `recentToolActivity` (bounded to 20 by Session State itself, §`PHASE_5_SESSION_ARCHITECTURE.md` §2). There is no raw conversation transcript anywhere in this package — "do not dump entire conversation history blindly" is satisfied structurally: the schema simply has no field capable of holding one.

The actual context handed to the receiving provider (`contextEnvelope`) is:
- a synthesized **resume-instructions block** (§4), always present;
- plus whatever Tencent Memory content resulted from §2 (fresh, snapshot, or none);
- **token-budgeted** through Phase 4's real `allocateBudget`, against the *target* provider's context window — not the source's, since that's what the receiving agent will actually have to work within.

## 4. Resume semantics — and why the resume block is un-droppable "for free"

`buildResumeInstructionsBlock()` (`src/handoff/resume-block.ts`) renders every item the brief's §5 lists — this is an existing task, don't re-audit; objective; completed; remaining; decisions already made (labeled "do not re-litigate without new evidence"); relevant files; repo/worktree status; recent tool activity — plus a stale-state warning section when applicable.

**Design choice worth calling out**: this block is given `class: "instructions"`. Phase 4's Token Manager already treats `instructions` as genuinely untouchable — never trimmed, under any budget pressure, full stop (`PHASE_4_CACHE_TOKEN_REPORT.md` §1). Making the resume block an `instructions`-class block means it inherits that protection automatically, with zero handoff-specific budgeting logic — `flush.test.ts`'s "survives even an extremely tight token budget" test proves this directly (`contextWindow: 5` still leaves the resume block fully intact, with `criticalContentOverBudget: true` flagged rather than the block being silently cut).

## 5. Stale-state detection in practice

`flushHandoff` accepts an optional `currentGit` fingerprint; when both it and the session's stored `git` are present, `compareGitFingerprints` (Phase 5 session module) runs, and the result lands in `HandoffPackage.staleness` **and** is rendered directly into the resume block as a `⚠️ STALE STATE WARNING` section naming the specific reasons (branch changed, HEAD changed, etc.) — the receiving agent sees this in its own context, not just in a machine-readable field a caller might ignore. When `currentGit` isn't supplied at all, staleness is reported as `false` (can't compare, not "assumed fine") — matching the same "partial fingerprint is OK, missing means unknown" stance the underlying comparison already takes.

## 6. Provider selection — the explicit, no-auto-pick guarantee

Two separate, required calls, not one with a default:

```ts
const { availableProviders } = await handoffManager.prepareHandoff(sessionId); // never picks
// ... a human chooses one ...
await handoffManager.finalizeHandoff(sessionId, chosenProviderId, opts);        // no default for chosenProviderId
```

There is no third path. `finalizeHandoff` validates the chosen id two ways: `ProviderRegistry.get()` throws `UnknownProviderError` for an unregistered id (Phase 3's existing error, reused, not reimplemented); a registered-but-`cliAvailable: false` provider throws the new `HandoffProviderUnavailableError`. Both are tested with a real unregistered id and a real synthetic no-CLI provider profile respectively — and both tests also assert the session was **not modified** by the failed attempt (session mutation only happens after the package is fully built and rendered, so a validation failure can never leave partial handoff state).

## 7. What was deliberately not built

Per the hard boundary: no autonomous agent selection (the two-call API above is the entire enforcement mechanism), no production launcher rewrite (`windows/launch-tencent-claude.ps1` untouched — this is exactly the "tested harness/API... sufficient" case the brief calls out, since wiring a real interactive "which agent should take over" prompt into the PowerShell launcher would cross that boundary), no MCP, no distributed handoff state (a `HandoffPackage` is a plain in-memory value returned from `finalizeHandoff`; persisting a *history* of past handoffs beyond `TaskSession.lastHandoff`'s single most-recent record was not built — flagged in `PHASE_6_ENTRY_CRITERIA.md` as a real gap if handoff auditing across multiple transfers is ever needed).

Codex is not wired into provider selection at all this phase — it was never added to the Provider Registry in Phase 3 either, so there's nothing to select. Stated plainly rather than silently absent.
