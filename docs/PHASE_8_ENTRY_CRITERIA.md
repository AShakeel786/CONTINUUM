# Phase 8 Entry Criteria

Phase 7 (cross-platform launcher) is closed. This lists what's satisfied, what
it revealed but deliberately did not build, and the decisions needed before
Phase 8 starts.

## Satisfied

- [x] Project registry: add/remove/list, aliases, CWD detection, default
  provider/model.
- [x] `continuum` launch flow: project → task → provider → launch (reusing
  Provider Registry, auth/credentials, Context Manager, session state, handoff,
  pricing — no duplication).
- [x] Launch Claude/DeepSeek with correct auth/context/session identity.
- [x] Resume with stale-worktree protection (git-fingerprint comparison).
- [x] Manual handoff + DeepSeek peak-pricing handoff prompt (ask-which-agent,
  never auto-select; session preserved).
- [x] MemoryCore when available; clear degradation when not.
- [x] Cross-platform paths; no tencent `.ps1` / hardcoded-machine dependency.
- [x] Safe permissions by default; bypass explicit opt-in.
- [x] 253 tests + typecheck green; Tencent stack healthy; Phase 6 committed
  (`8f41186`, not pushed) before Phase 7 began.

## What Phase 7 revealed (documented, not built)

1. **DeepSeek proxy-CLI launch seam.** DeepSeek's *CLI* launch routes through
   the Tencent MemoryProxy and needs `CONTINUUM_TENCENT_PROXY_USER_KEY`, which
   Phase 6's credential backend does not own (the proxy holds DeepSeek's
   upstream key server-side). DeepSeek *direct-API* auth works via the stored
   `DEEPSEEK_API_KEY`. Closing this means either adding proxy secrets to the
   credential backend or documenting the proxy key as an explicit env-var step.
2. **No interactive provider-choice prompt in the launcher itself.** `launch`
   uses `--provider` or the project default; the "which agent" prompt exists
   only in `handoff`. A first-launch "pick a provider" prompt (when neither a
   default nor `--provider` is given) is a natural follow-up, not built here.
3. **No session listing/cleanup surface.** The launcher resumes by explicit
   session id only; `FileSessionStore.listSessionIds()` exists but no command
   surfaces a "resume recent task" list. Phase 5 already flagged the retention
   gap; this is the same gap from the completion side.
4. **`resume`/`launch` don't record handoff metadata when the provider changes.**
   Only `handoff` goes through `HandoffManager.finalizeHandoff` (which records
   the transition); a `resume --provider X` against a session whose active
   provider differs would change the provider without recording it. Minor, but
   a consistency seam.

## Decisions needed before Phase 8

1. **Which Phase 8 direction?** The original sequencing's remaining independent
   candidate is the **MCP wrapper around MemoryCore's Gateway API** (unchanged
   since Phase 2, can run in parallel with anything). Alternatives: a
   session-listing/cleanup surface (ties off Phases 5–7 completion-side gaps),
   the combined live-verification effort (seeded MemoryCore identity covering
   Phase 4 harness + Phase 5 handoff + Phase 7 launch), or the deepseek
   proxy-key seam above.
2. **Proxy-secret management** — should `CONTINUUM_TENCENT_PROXY_USER_KEY`
   become a first-class credential backend entry, or stay an explicit
   environment variable? (Affects the DeepSeek CLI-launch path only.)
3. **Interactive provider choice on first launch** — build the prompt now or
   leave `--provider`/default as the only selectors?

## Recommended Phase 8 starting point

**MCP wrapper around MemoryCore's Gateway API** — it has been independent since
Phase 2, is explicitly out of scope so far (nothing built), and completes the
memory integration the launcher (Phase 7) and context pipeline (Phase 4) now
depend on. The session-listing/cleanup surface is the strongest complementary
follow-up to tie off the completion-side gaps Phase 5 and Phase 7 both flagged.
