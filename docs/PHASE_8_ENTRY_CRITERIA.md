# Phase 8 Entry Criteria

Phase 7.1 (launcher UX closure) is closed, completing the launcher work.
Phase 7 committed at `7423da8`; Phase 7.1 uncommitted. This lists what's
satisfied, what remains explicitly out of scope, and the decision before
Phase 8 starts.

## Satisfied (Phase 7 + 7.1)

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
- [x] **Proxy key stored through CredentialManager** — no manual env setup for
  DeepSeek proxy use (`deepseek`/`proxy-user-key`).
- [x] **First-launch provider prompt** from configured + authenticated providers
  when neither `--provider` nor a project default is given.
- [x] **Recent-session listing/resume** (`continuum sessions`, `resume --recent N`)
  plus archive of finished sessions.
- [x] **Provider-change-on-resume records handoff** (no fake handoff on
  same-provider resume).
- [x] **Upstream API key never enters a proxy-routed launch env.**
- [x] 260 tests + typecheck green; Phase 6 (`8f41186`) and Phase 7 (`7423da8`)
  committed; Tencent stack healthy throughout.

## Still out of scope (unchanged, deliberate)

- MCP wrapper around MemoryCore's Gateway API.
- Gemini/Codex/local-model providers.
- UI, Health/Recovery, Docker redesign.
- Automatic provider selection (always explicit user choice).

## Remaining seams (minor, documented)

1. **Proxy key is set separately from the API key** — `continuum auth deepseek`
   prompts for both in sequence; the proxy key is Tencent-proxy-local and cannot
   be derived from the upstream key. One-time setup, not a runtime gap.
2. **Archive is time-gated on `completed`/`abandoned` only** — "paused" sessions
   that go idle are never archived. Deliberately conservative.
3. **First-launch prompt returns a singleton directly** when exactly one provider
   is usable (explicit, but no user keystroke). Fine at two providers.

## Decision needed before Phase 8

**Confirm Phase 8 = MCP wrapper around MemoryCore's Gateway API.** It has been
independent since Phase 2, is the last explicitly-scoped-but-unbuilt item, and
completes the memory integration the launcher (Phase 7/7.1) and context pipeline
(Phase 4) already depend on. No competing candidate has emerged since Phase 7's
own recommendation; the session-listing surface (now built) no longer needs to
be a standalone follow-up.

## Recommended Phase 8 starting point

**MCP wrapper around MemoryCore's Gateway API** — implement the already-mapped
`/v3/*` read endpoints (`/v3/core/read`, `/v3/scenario/ls`, `/v3/atomic/search`)
as MCP tools, reusing `src/context/memorycore-client.ts` as the transport and
`src/context/mapper.ts` for block mapping, so the launcher and a standalone MCP
client share one boundary. No new `recall` engine, no L0–L3 rewrite.
