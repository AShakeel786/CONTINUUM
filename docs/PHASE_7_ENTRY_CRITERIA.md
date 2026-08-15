# Phase 7 Entry Criteria

Phase 6 (onboarding & auth) is closed. This lists what's satisfied, what it
revealed but deliberately did not build, and decisions needed before Phase 7
starts.

## Satisfied

- [x] `continuum` CLI entrypoint with `setup`, `providers`, `auth [--remove]`,
  and `doctor` commands.
- [x] `ProviderSetup` / `AuthVerifier` / `SetupWizard`, using the existing
  Provider Registry and CredentialManager architecture — no provider-specific
  switches (metadata/adapters express all behavior).
- [x] Credential storage via `CredentialBackend` (macOS keychain live-verified
  with disposable credentials; Windows DPAPI + Linux Secret Service
  implemented from contract; AES-256-GCM encrypted-file fallback).
- [x] Config stores `credential://` references only — no plaintext secrets in
  config, state, logs, or git.
- [x] Masked interactive API-key prompts; CLI auth detection/login for Claude
  without disrupting the real authenticated session.
- [x] DeepSeek API-key setup via masked prompt + secure backend (no manual
  `.env`/YAML editing).
- [x] Credential replace/remove flows; fresh-machine onboarding with no
  Windows paths, no project registry, no preconfigured env.
- [x] 235 tests green (206 baseline + 29 new); typecheck clean; four docs
  written.

## What Phase 6 revealed (documented, not built)

1. **macOS `security` argv exposure** — the single unavoidable secret path
   (see `PHASE_6_SECURITY_REPORT.md`). Fixing it needs a native Keychain
   binding, not a CLI wrapper. Worth a deliberate follow-up rather than an
   in-phase hack.
2. **No native backend verification on Windows/Linux** — DPAPI and Secret
   Service are contract-implemented, not live-tested (no such machines here).
   A targeted follow-up on real Windows/Linux is the honest next check.
3. **Passphrase-keyed fallback has no strength enforcement** — the
   encrypted-file backend accepts any passphrase. Enforcing strength is a
   policy question, not an omission.
4. **Verification is structural, not live** — setup never makes a billable
   upstream call. A first real use catches a mis-copied key; a deliberate
   "verify by pinging" mode (opt-in, bounded) is a possible follow-up.
5. **Config schema is v1 and flat** — fine for two providers; a migration
   path should be agreed before adding fields that older configs won't have.

## Decisions needed before Phase 7

1. **Which Phase 7 direction?** The original sequencing still has the
   independent candidates — notably the **MCP wrapper around MemoryCore's
   Gateway API** (unchanged since Phase 2, can run in parallel with
   anything). Alternatives: cross-platform launcher (to actually wire the
   CLI launch plans + "which agent takes over" prompt built in Phases 3–5),
   session retention/handoff-history (Phase 5's own follow-ups), or a
   combined live-verification effort (seeded MemoryCore identity covering
   Phase 4 harness + Phase 5 handoff + Phase 6 auth against real data).
2. **Native Keychain binding now or later?** The macOS argv limitation is
   the one place a secret can leak. If "zero argv exposure" is a hard
   requirement, a native binding (or moving off the `security` CLI) becomes a
   standalone task.
3. **Gemini/Codex/local-model providers** — still no concrete need (unchanged
   recommendation since Phase 4: defer).
4. **Config schema migration policy** — agree on forward/backward
   compatibility rules before v2 fields land.

## Recommended Phase 7 starting point

**Cross-platform launcher** — it is the natural consumer of everything built
so far (Phase 3 launch plans, Phase 4 context, Phase 5 handoff selection,
Phase 6 auth), and it closes the "nothing is interactively wired together"
gap that Phases 4 and 5 both flagged. The MCP wrapper remains the strong
parallel-compatible candidate if a separate track is preferred.
