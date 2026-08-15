# Provider Pricing-Window Awareness

A Phase 5 addendum: `src/pricing/` adds peak/off-peak cost-window awareness to Session State, plus optional (never automatic) handoff suggestions when a provider's peak pricing starts. Builds directly on Phase 5's `src/session/` and `src/handoff/` — no new architectural layer, no changes to either.

---

## 1. Data-driven, not hardcoded business logic

DeepSeek's current official peak windows (`01:00–04:00 UTC`, `06:00–10:00 UTC`) live as plain data in `src/pricing/schedules/deepseek.ts` — a `ProviderPricingSchedule` object, same pattern as `src/providers/profiles/deepseek.ts`. Nothing in the calculation engine (`calculator.ts`, `notifications.ts`) mentions "DeepSeek" or contains a literal `01:00`/`04:00` anywhere. If DeepSeek's real published schedule changes, updating `schedules/deepseek.ts`'s data is the entire fix — no runtime-logic change, matching the brief's explicit "do not hardcode this permanently as business logic."

## 2. Calculator — UTC-internal, exact at boundaries

`getCurrentTier(schedule, now)` and `getNextTransition(schedule, now)` do all arithmetic on UTC minute-of-day (`getUTCHours()`/`getUTCMinutes()`, never local-time getters). Windows are half-open `[start, end)`: a session starting exactly at `01:00:00.000Z` is peak; one starting exactly at `04:00:00.000Z` is not — verified at millisecond precision in `calculator.test.ts`. The calculator generalizes beyond DeepSeek's two clean, non-adjacent windows: it correctly handles midnight-crossing windows too (tested), and `getNextTransition` re-derives the actual tier at each candidate boundary rather than assuming every window edge is a real change — robust to adjacent/overlapping windows without special-casing them.

**A real bug found and fixed via testing, not by inspection**: the first implementation of `getNextTransition` was strictly-future (`> now`), which is correct for "what's coming up" diagnostics but silently *skipped* a transition landing exactly on the check instant — a "peak just started" check running at precisely `01:00:00.000Z` would report the *following* transition (`04:00`, off-peak) instead of recognizing peak had just begun. Fixed with a second function, `getTransitionAtOrAfter`, used specifically by the notification layer: if `now` itself is a transition instant (tier differs from one millisecond before), it returns that transition directly; otherwise it defers to the normal strictly-future `getNextTransition`. `getNextTransition` itself is unchanged and still used for diagnostics, where "strictly next" is the correct semantic.

## 3. Notifications — pre-peak and peak-start only, deduplicated via session state

Only the off-peak → peak direction produces user-facing notifications (`"pre-peak"`, `"peak-started"`) — matching the brief's examples and explicit test list; there's no symmetric "off-peak starting" notification (not requested, would be unused). Both message strings match the brief's examples exactly:

```text
DeepSeek peak pricing starts in 15 minutes. Continue with DeepSeek or hand off to another provider?
DeepSeek is now in peak pricing. Current session can continue, or you can hand it off to another available provider.
```

`providerDisplayName` is a parameter (sourced from the real Phase 3 Provider Registry's `displayName`), not a hardcoded string — the same message-building logic works for any future provider with a pricing schedule.

**Deduplication is what makes "no duplicate notification after restart" real, not just a docstring claim**: each check persists a `PendingNotificationRecord` (`{transitionAt, toTier, preNotified, startNotified}`) onto `TaskSession.pricingAwareness` via `SessionManager.updatePricingAwareness`. A later check — including one from a brand-new process reading the same session file — loads that record, sees the same `transitionAt` still being tracked, and only fires an event for whichever notification kind hasn't fired yet. Once the *next* real transition supersedes it (a different `transitionAt`), the record resets. Tested with two fully independent `SessionManager`/`PricingAwarenessService` instances sharing only the on-disk session directory — a genuine simulated restart, the same technique Phase 5's own durability tests use.

## 4. Diagnostics and the handoff suggestion — read-only, non-automatic

`PricingAwarenessService.diagnostics(session)` renders a line like `"DeepSeek: currently off-peak; next transition to peak at 01:00 UTC (21:00 local), in 3h 20m"` — the brief's "show the next peak/off-peak transition in session diagnostics," using `describeTransition()` (`format.ts`) for the UTC+local+relative combination.

`suggestHandoffOnPeakEvent(event, handoffManager)` packages a peak-related notification's message together with `HandoffManager.listAvailableReceivingProviders()` (Phase 5, unmodified) — nothing more. It never calls `finalizeHandoff`, never picks a provider, and never mutates session or provider state; it's read-only packaging of information a caller (a human, via whatever UI/CLI surface presents the notification) uses to actually decide. Tested end-to-end: a suggestion's chosen provider can be fed straight into a real `HandoffManager.finalizeHandoff` call and completes exactly like any other Phase 5 handoff — this feature adds *no* new handoff mechanism, it only offers an entry point into the existing one.

## 5. What was deliberately not built

No automatic provider switching, anywhere — confirmed by the fact that `check()` and `suggestHandoffOnPeakEvent()` both have no code path capable of calling `finalizeHandoff`. No off-peak-starting notifications (not requested). No per-provider pricing beyond DeepSeek (Claude has no peak/off-peak concept in this codebase, so it has no schedule entry — `hasSchedule()` correctly reports this and `check()` is a documented no-op for such providers, not an error).
