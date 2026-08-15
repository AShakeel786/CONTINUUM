# Phase 7.1 — Launcher UX Closure

Closes the usability/integration gaps left after Phase 7, before MCP work.
Built on Phase 7's commit `7423da8`.

## What closed

1. **Proxy key via CredentialManager** — `CONTINUUM_TENCENT_PROXY_USER_KEY`
   is now a first-class credential (`deepseek`/`proxy-user-key`), stored
   through the same masked prompt + secure backend as API keys. The launcher
   resolves it into the launch plan via `CliLaunchContext.secrets`, so a
   normal DeepSeek proxy launch needs **no manual env setup**.
2. **First-launch provider prompt** — when `launch` has no `--provider` and
   the project has no default, the launcher prompts from the set of *configured
   + authenticated* providers, never auto-selecting.
3. **Recent-session listing/resume** — `continuum sessions` lists recent
   sessions newest-first; `resume --recent N` resumes without recalling an id;
   `sessions archive --older-than ISO` retires finished/abandoned sessions.
4. **Provider-change-on-resume records handoff** — `resume --provider X`
   where X differs from the session's active provider routes through normal
   handoff semantics (`recordHandoff` + `setActiveProvider`), so the transition
   is recorded and the receiving agent sees a "continue, don't re-audit" prompt.
   A same-provider resume writes **no** fake handoff.
5. **Upstream-key leak closed** — the DeepSeek API key is no longer injected
   into a *proxy-routed* CLI launch's env (the proxy holds it server-side); only
   the proxy user key reaches the child. Verified by test.

## No redesign

Existing modules remain the source of truth. The one extension to a completed
system is backward-compatible: `ProviderAdapter.buildCliLaunchPlan` accepts an
optional `ctx.secrets` map (originally `process.env` only), and `ProviderAuthMetadata`
gained an optional `proxyUserKey` descriptor. Neither changes existing behavior
when the new fields are absent.

## Tests (260 total: 253 + 7 new)

| Scenario | Result |
|---|---|
| proxy credential set/get + deepseek launch-plan activation | ✅ `env.ANTHROPIC_AUTH_TOKEN` = stored proxy key |
| upstream key not leaked into proxy launch | ✅ `env` has no `DEEPSEEK_API_KEY` |
| first-launch provider prompt (single available) | ✅ returned |
| no usable providers | ✅ throws `NoAuthenticatedAgentError` |
| recent-session ordering/membership | ✅ |
| archive finished (active untouched) | ✅ |
| provider-change-on-resume records handoff | ✅ `lastHandoff` set, `from`/`to` correct |
| same-provider resume → no fake handoff | ✅ no `lastHandoff` write |
| no secret leakage | ✅ upstream key absent from plan JSON |

Existing 253 tests + typecheck remain green. Tencent/MemoryCore healthy
throughout; zero Tencent-repo changes.

## Risks / remaining seams

- **Proxy user key is still distinct from the API key** — a user must run
  `continuum auth deepseek` once to set both (masked prompts in sequence). The
  proxy key is Tencent-proxy-local and cannot be derived from the upstream key.
- **Archive is time-gated only on `completed`/`abandoned`** — paused or
  handoff-pending sessions are never archived, even if stale. Deliberate
  (conservative), but a long-idle "paused" session will accumulate.
- **First-launch prompt returns a singleton without re-confirming** — when
  exactly one provider is usable, it's returned directly (still explicit, not
  "auto", but no user keystroke). Acceptable for now; revisit if more providers
  are added.

## Phase 8 readiness

**Ready for Phase 8 (MCP wrapper).** The launcher is now a complete daily
driver: project → provider (auto/selected) → credential-aware launch →
session resume/handoff → cleanup, with no manual env setup and no secret
leakage. The one remaining integration seam (proxy key) is stored, not manual.

Workspace state: Phase 7 committed at `7423da8`; Phase 7.1 is uncommitted.
