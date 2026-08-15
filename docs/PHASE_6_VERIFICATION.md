# Phase 6 — Verification

What Phase 6 built, and every place it was proven. Tests are unit-level and
deterministic (no network, no real credential, no real `claude` login); the
one live check — the macOS Keychain backend — used a disposable credential
only and is noted where it is.

## Test coverage (235 total: 206 baseline + 29 new)

| Module | Tests | What they prove |
|---|---|---|
| `credential-manager` | 5 | `credential://` reference round-trip; `get`/`has`/`delete`; not-found error; names-only listing |
| `prompt` | 3 | scripted prompt consumes answers/secrets/confirms in order; records asked secrets for no-leak assertions; falls back to defaults |
| `provider-setup` | 5 | masked API-key storage returns a reference; empty key refused; CLI login returns `cli` with no uri; config entries store references (not values) and replace/remove correctly |
| `auth-verifier` | 4 | API missing/ok; detail never contains the secret; CLI not-installed |
| `setup-wizard` | 3 | initialize selects+records backend idempotently; non-interactive skips all; interactive declined-then-accepted stores only references |
| `doctor` | 3 | healthy with no providers; unhealthy on missing credential; healthy on resolved credential; report never contains the secret |
| `activation` | 3 | env-var name resolution; env resolution without mutating `process.env`; `InvalidCredentialError` for non-credential auth |
| `encrypted-file` | 3 | set/get/delete round-trip; vault on disk is ciphertext-only; wrong passphrase cannot decrypt (GCM auth failure surfaces) |

Baseline (Phases 1–5) remains 206 green, untouched.

## Required-test matrix from the brief

| Requirement | Covered by |
|---|---|
| first-run + rerun | `setup-wizard` idempotent `initialize` |
| credential set/get/delete/replace | `credential-manager`, `provider-setup` (replace = re-run setup; remove = `remove`) |
| masked input | `prompt` (scripted `askSecret` records but never echoes) + real TTY masking in `createPrompt` |
| invalid auth | `auth-verifier` missing/empty; `activation` `InvalidCredentialError` |
| CLI installed/authenticated states | `auth-verifier` (not-installed) + `claude` metadata status parsing |
| interrupted auth (empty key) | `provider-setup` "refuses empty key" |
| doctor healthy/unhealthy | `doctor` |
| no secret leakage | multiple `not.toContain("<secret>")` asserts across config/verify/report/vault |
| fresh-user setup | `setup-wizard` non-interactive `[]` config; scratch-`CONTINUUM_HOME` CLI runs (below) |

## CLI end-to-end (scratch `CONTINUUM_HOME`, disposable)

```
$ CONTINUUM_HOME=$(mktemp -d) node dist/cli/bin.js doctor
Backend: macos-keychain (os-native)
Overall: healthy
No providers configured.
exit=0

$ CONTINUUM_HOME=... node dist/cli/bin.js providers
claude: not configured
deepseek: not configured

$ node dist/cli/bin.js auth gemini
Unknown provider "gemini". Known: claude, deepseek
exit=2

$ node dist/cli/bin.js auth deepseek --remove
Removed stored auth for deepseek.
```

Persisted config after `auth` contains `credentialBackendId: "macos-keychain"`
and `providers: []` — a reference-only file with **no** secret value.

## Live macOS Keychain check (disposable only)

Through the real `security` CLI and the real `MacosKeychainCredentialBackend`:

- `selectCredentialBackend` picked `macos-keychain` (`native darwin backend detected and working`).
- `setCredential("deepseek", "api-key", "sk-test-disposable-12345-NOT-REAL")` → `credential://deepseek/api-key`.
- `getCredential` returned the identical value (match).
- `deleteCredential` removed it; `hasCredential` → false.
- `listProviderCredentialNames("deepseek")` → `[]` (no real provider credential touched).

## What was NOT verified (documented, not hidden)

- Real `claude auth login` — deliberately never invoked (this session is
  inside Claude Code). Login/logout proven via injected fake adapters.
- Linux Secret Service and Windows DPAPI backends — implemented from their
  documented contracts, not live-tested (no such machine in this environment).
- Live non-empty upstream API call — verification is structural by design;
  a real keyed call is out of scope for setup.
