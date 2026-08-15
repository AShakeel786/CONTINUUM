# Phase 6 — Onboarding & Auth Architecture

Phase 6 turns CONTINUUM from a library of verified building blocks into a
tool a fresh machine can actually adopt: a `continuum` CLI that walks a new
user through credential setup, stores secrets in an OS-native backend
(never plaintext), and reports health — with zero dependency on this
project's existing Windows paths, Tencent project registry, or any
preconfigured environment.

## The split (data vs. behavior, matching Phases 3–5)

Every prior phase kept *data* (serializable, secret-free) separate from
*behavior* (testable, holds-a-thing). Phase 6 does the same:

| Layer | Type | Responsibility |
|---|---|---|
| `CredentialBackend` | behavior | Store opaque `key`→`secret` pairs. No provider knowledge. |
| `CredentialManager` | behavior | Provider-facing API; builds/parses `credential://` references. |
| `ProviderAuthMetadata` | **data** | What auth a provider supports (API env var, CLI executable/args). No functions. |
| `CliAuthAdapter` | behavior | Generic detect/login/logout, driven by metadata + optional status parser. |
| `CliAuthManager` | behavior | Registry over adapters (same shape as `ProviderRegistry`). |
| `ProviderSetup` | behavior | Per-provider setup/replace/remove, switching on `api.supported`/`cli.supported` *discriminants*, never provider id. |
| `AuthVerifier` | behavior | Post-setup validation (API: credential resolves & non-empty; CLI: installed & authenticated). |
| `SetupWizard` | behavior | First-run init + orchestration across all providers. |
| `ConfigStore` (`src/config/`) | data | Non-secret record of *which* provider is configured *how* — references only. |
| `continuum` CLI (`src/cli/`) | entrypoint | `setup` / `providers` / `auth` / `doctor` commands. |

## Credential storage — references, never values

CONTINUUM config stores a `credential://<provider>/<name>` reference. The
actual secret lives only in the selected `CredentialBackend`:

- **macOS** → `macos-keychain` (`security` CLI, `add-generic-password`).
- **Windows** → `windows-dpapi` (DPAPI `CurrentUser` scope, secret via stdin).
- **Linux** → `linux-secret-service` (`secret-tool`, secret via stdin).
- **Fallback** → `encrypted-file` (AES-256-GCM, scrypt KDF, `~/.continuum/vault.enc.json`).

`selectCredentialBackend` picks native-first, falling back to the
encrypted-file backend only when no native option works — and reports *why*,
never silently. The chosen backend id is recorded in config so later runs
(`doctor`, `providers`) read from the same place a credential was written.

## Auth methods, expressed as data

- **Claude**: both `api` (`ANTHROPIC_API_KEY`) and `cli` (`claude auth
  login`). CLI status is parsed from real `claude auth status` JSON
  (`loggedIn` boolean) — never guessed from exit code alone.
- **DeepSeek**: `api` only (`DEEPSEEK_API_KEY`). No dedicated DeepSeek CLI
  exists in this deployment, so `cli.supported` is honestly `false`.

`ProviderSetup.setup` chooses the method from these discriminants. A
provider with both methods defaults to `cli` (the familiar, OAuth-backed
flow) unless `preferredMethod` says otherwise. There is no switch on
`providerId` anywhere in the auth path — metadata and adapters express all
behavior.

## Masked interactive prompts (`src/auth/prompt.ts`)

`Prompt` is an injectable interface (`ask`, `askSecret`, `confirm`); every
flow reads input through it, so tests inject a scripted prompt and never
touch a TTY. A real `createPrompt()` masks `askSecret` by disabling echo
via Node's `readline` `_writeToOutput` hook when stdin is a TTY, so a
pasted API key is never displayed or echoed into scrollback. When stdin is
not a TTY (piped/tests) masking is impossible and meaningless, and the read
proceeds unmasked.

## The CLI (`src/cli/`)

- `continuum setup` — first-run init (data dir + backend selection) then
  per-provider onboarding.
- `continuum providers` — list providers and auth state (status + reference,
  never a value).
- `continuum auth <provider> [--remove]` — (re)authenticate one provider, or
  forget it.
- `continuum doctor` — read-only health report; exit 0 = healthy, 1 =
  unhealthy.

No secret is ever written to stdout. Secret values appear only: (a) on the
masked prompt input, (b) briefly in the selected backend's storage call, and
(c) in `activation.ts`'s returned env-var object, which is handed to a child
process and never mutates the live `process.env`.

## Fresh-machine guarantee

Nothing below assumes Windows paths, the Tencent project registry, existing
env vars, manual YAML editing, or this project's current setup:

- Data dir is `os.homedir()/.continuum` (or `$CONTINUUM_HOME`), created on
  demand.
- Providers are autodetected from `ProviderAuthMetadata`, not a hardcoded
  list of paths.
- Credential references resolve against the selected backend, which the CLI
  records on first write.

## Known, explicitly-documented security limitation

The macOS `security add-generic-password` command has **no stdin option** for
the secret — it must be passed via `-w <value>`, so the value briefly appears
in that child process's own argv during `set()`. This is a documented
limitation of the `security` CLI itself, not something Phase 6 works around
(doing so needs a native Keychain binding). Every other secret path in the
codebase avoids argv exposure; this one is the single, confined exception.
See `PHASE_6_SECURITY_REPORT.md`.
