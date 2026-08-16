# Phase 15 — Codex Provider Integration Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** Add Codex as the third real provider via the existing generic architecture.

## Approach (no redesign)

Codex is registered as pure data through the existing provider/auth machinery —
no provider-identity switches anywhere. Everything branches on existing capability
metadata (`protocol`, `cliAvailable`, `auth.kind`, `cliLaunch.kind`).

- **Profile** (`providers/profiles/codex.ts`): `cliLaunch.kind: "native"`, `auth.kind:
  "cli-session"` (CONTINUUM holds no Codex secret), `protocol: "openai-compatible"`,
  default model `gpt-5.6-sol` read live from `codex debug models` (priority-1).
- **Auth** (`auth/provider-auth/codex.ts`): CLI-only metadata (`codex login status`),
  parser mapping "Logged in …"/"Not logged in" → authenticated/not-authenticated.
- **Wiring**: registered in `createDefaultProviderRegistry` + `createDefaultProviderAuthMetadata`
  + `createDefaultCliAuthManager`.

## Implementation details

| File | Change |
|---|---|
| `providers/profiles/codex.ts` | new profile (native launch, cli-session auth) |
| `auth/provider-auth/codex.ts` | new metadata + `createCodexCliAuthAdapter` + `parseCodexAuthStatus` |
| `providers/index.ts` | register codex + export |
| `auth/provider-auth/index.ts` | register codex metadata + CLI adapter |
| `providers/types.ts` | `NativeCliLaunch.configDirName` made optional (Codex uses native `~/.codex`) |
| `auth/cli-auth-adapter.ts` | **status parser now receives `stderr`** (Codex writes `login status` to stderr) |

### Notable live bug caught
`codex login status` prints "Logged in using ChatGPT" to **stderr**, not stdout. The
generic CLI-auth adapter only forwarded stdout to the parser, so Codex auth would have
mis-reported as `unknown`. Fixed by extending `StatusParser` to `(stdout, stderr, exitCode)`
(backward-compatible; Claude's existing parser ignores the extra params).

## Live result (installed Codex CLI 0.147.0)

- `codex --version` → `codex-cli 0.147.0` (exit 0).
- `codex login status` → `Logged in using ChatGPT` (exit 0).
- CONTINUUM adapter: `detectInstalled` → `installed`; `detectAuthenticated` → `authenticated`.
- `Doctor.diagnose` with codex configured `cli` → `healthy — codex reports authenticated`.
- No `codex login` invoked, no paid LLM call made, `~/.codex/auth.json` untouched.

## Handoff results (unit)

- Claude → Codex: openai-compatible joined-string, inherits `completedWork`/`remainingWork`,
  activeProvider → codex (no re-audit via `<handoff-resume>` block).
- DeepSeek → Codex: same mechanism, target model `gpt-5.6-sol`.
- Codex → Claude: Anthropic block-array + cache directive.
- Codex → DeepSeek: openai-compatible joined-string.

## Tests

- `npm test` → **47 files / 321 tests passed** (added: codex-adapter 6, codex-auth 5, codex-launcher 5).
- `npm run typecheck` clean; `npm run build` clean.
- Coverage added: detection/auth, launch plan (no credential/configDir injected), project
  launch, missing/unauthenticated CLI gating, auth/env isolation, no-secret-leakage, handoff
  (all four directions), safe permission defaults.

## Tencent health

- Tencent stack untouched and healthy (`tdai-memory-core`/`tdai-proxy`/`tdai-memory-hub` Up healthy).
- No files changed in `TencentDB-Agent-Memory`.

## Risks

1. **Codex `login status` contract is stream-sensitive** — it writes to stderr. If a future
   Codex release moves it to stdout or changes wording, the parser needs a corresponding tweak
   (it already reads both streams and is case-insensitive, so the blast radius is small).
2. **Default model is informational** — native launch passes no `--model`, so Codex uses its
   own config default; `gpt-5.6-sol` is session/display metadata only.
3. **`continuum auth codex` runs the real interactive `codex login`** — correct, but not
   exercised live (would disrupt the existing authenticated session).
4. **Codex has no pricing schedule** — `PricingAwarenessService.check` is a no-op for it
   (verified), so no peak/off-peak handoff prompts for Codex sessions.

---

## Phase 16 recommendation

The next highest-value, lowest-risk step is **provider parity + first-class session
continuity for the native CLIs** (Claude + Codex), closing the one gap Phase 15 exposed
rather than adding a fourth provider:

1. **Native CLI session-identity bridge.** CONTINUUM records `activeProvider` in its own
   session store, but the native CLIs (Claude/Codex) each keep their own resume state. A thin
   adapter that maps a CONTINUUM `sessionId` → the native CLI's resume invocation (Claude's
   `--resume`, Codex's `resume` subcommand) would make "receiving agent continues, not
   re-audits" true end-to-end at the process level, not just in the rendered context block.

2. **Codex MCP wiring (config, not code).** CONTINUUM's MCP tools are already
   provider-independent; the remaining piece is a generated `codex mcp add` snippet
   (and the equivalent for Claude) so a launched agent auto-connects to `continuum-mcp` —
   surface it in `continuum providers`/`doctor`, no new runtime logic.

3. **Provider launch-plan smoke tests against the real CLIs.** Phase 15 verified detection
   and handoff in-process; a non-interactive, non-billable `--help`-only launch-plan smoke
   (assert executable + args + env isolation) for each provider would catch the next
   "writes to stderr"-class contract drift before it ships.

Deliberately NOT recommended next: a fourth provider, local/Gemini models, UI, or pricing
schedules for Codex — none of those are prerequisites to the above, and each would
expand surface area before the three-provider path is fully exercised live.
