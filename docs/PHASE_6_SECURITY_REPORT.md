# Phase 6 — Security Report

Read this before relying on Phase 6's credential handling. Every protection
and every limit is stated plainly, in the same "plainly rather than glossed
over" style as prior phases' own reports.

## What protects secrets

| Path | Mechanism | Protects against |
|---|---|---|
| Config (`~/.continuum/config.json`) | Stores `credential://<provider>/<name>` references only — never a value | Accidental disclosure of the secret via config; committing config to git |
| macOS backend | Keychain via `security` CLI | File-read disclosure; values tied to the login keychain |
| Windows backend | DPAPI `CurrentUser` scope, secret via stdin | File-read disclosure; key managed by Windows, tied to the profile |
| Linux backend | Secret Service, secret via stdin | File-read disclosure; keyring-protected |
| Fallback backend | AES-256-GCM + scrypt (Node stdlib `crypto`, no home-grown crypto) | Accidental disclosure only — see limits |
| CLI auth (Claude) | CONTINUUM never sees/stores the token; `claude auth login` inherits stdio | Token exfiltration by CONTINUUM itself |
| Activation | Returns `{envVar: value}` for a child process; never mutates `process.env` | Leakage into unrelated code paths for the process lifetime |
| Prompts | Masked `askSecret` (echo disabled on TTY) | Secret appearing in terminal scrollback |

## The one argv exposure (macOS), kept explicit

`macos-keychain`'s `set()` runs:

```
security add-generic-password -a <key> -s continuum -w <secret> -U
```

macOS's `security add-generic-password` has **no stdin option for the
password**, so the secret is passed via `-w` and therefore appears in that
child process's own argv for its short lifetime — visible to same-user
`ps`/proc inspection during that window.

- This is a **documented limitation of the `security` CLI**, not something
  Phase 6 invents or silently accepts. It is stated in the backend's own
  type (`description`) so `doctor`/`setup` surface it to the user, and in
  `PHASE_6_ONBOARDING_ARCHITECTURE.md`.
- **Every other** secret path avoids argv: Windows (stdin), Linux (stdin),
  fallback (never spawns), CLI auth (never stores).
- Not mitigated this phase per the brief — solving it needs a native
  Keychain binding, out of scope, and should not derail Phase 6.

## What does NOT protect (honest limits)

1. **Encrypted-file fallback** protects only against *accidental* disclosure.
   Anyone who can run code as the same OS user **and** obtain/guess the
   passphrase can decrypt it — there is no OS-level key binding. The backend
   does not enforce passphrase strength.
2. **Memory inspection** — a decrypted value necessarily exists in memory
   while in use, same as any credential backend or native secret store.
3. **Verification is structural, not a live call.** `AuthVerifier` confirms a
   credential is present/non-empty (or that a CLI reports authenticated) —
   it deliberately does **not** fire a billable/secret-bearing upstream call
   during setup. A mis-copied-but-non-empty key is caught by the provider on
   first real use, not fabricated here.
4. **No secret is logged**, but the caller is responsible for not printing
   `resolveProviderAuthEnv`'s returned object (documented on the type).

## What was live-verified this phase

- macOS Keychain backend: **set → get → delete** round-trip against the real
  `security` CLI, using a **disposable** credential only; both items removed
  and verified gone. No real provider credential was touched.
- CLI auth login/logout were **never** invoked against the real `claude`
  binary (this session runs inside Claude Code; disrupting its authenticated
  session would be actively harmful). Instead, login/logout behavior is
  exercised through injected fake adapters in tests; status parsing is
  verified against `claude auth status`'s documented JSON shape.
- The argv-exposure window is too short to reliably observe via `ps` (the
  child exits in milliseconds); it is confirmed by reading the `security`
  contract, not by catching it in a race.

## No plaintext secrets

- Config, state, logs, and git receive **only** `credential://` references.
- Tests assert this: `JSON.stringify(config)` must not contain the injected
  secret; the encrypted-file test asserts the vault on disk is ciphertext.
- `providers`/`doctor` print references and status, never values.
