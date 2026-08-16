# Phase 18 — MCP Reliability + Codex Session Hardening Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** Make MCP genuinely plug-and-play (lifecycle + functional health) and replace
Codex's filename session-id heuristic with a proven canonical-id read.

## Implementation

### 1. MCP lifecycle (data-driven, non-secret config)
| Piece | Change |
|---|---|
| `config/types.ts` | `mcpAutoConfigure?: boolean` — one-time permission, non-secret |
| `auth/setup-wizard.ts` | asks once ("Allow CONTINUUM to auto-register its MCP server…"), persists |
| `mcp/registration.ts` | `ensureMcpRegistered()` — gated by autoConfigure, idempotent |
| `cli/commands/launch.ts` | `ensureMcpRegistration()` before spawn in launch/resume/handoff |

- Idempotent; never overwrites/removes unrelated MCP servers (CLI `mcp add` appends).
- Disabled/undecided → doctor prints the existing manual instruction (`continuum mcp-setup`).

### 2. MCP functional health
- `mcp/health.ts` — `verifyMcpHealth()` runs a real `initialize` handshake against `continuum-mcp`.
- Distinguishes: **reachable / protocol-failure / executable-missing / stale-path** (plus per-provider **registered** via `isMcpRegistered`).
- `doctor` reports: permission status + `continuum-mcp` functional health + per-provider registration + session contract.
- `doctor --repair` repairs missing registration when auto-configure is enabled; otherwise skips with the manual instruction. No secrets in config/output.

### 3. Codex native-session hardening
- `native-session.ts` — new `session-meta` id strategy reads the canonical `payload.session_id`
  from the JSONL `session_meta` record (first line only, streamed), falling back to `last-uuid`.
- `profiles/codex.ts` — `idFrom: "session-meta"`, `metaRecordType: "session_meta"`, `metaPayloadField: "session_id"`.
- Read-only: never modifies `~/.codex` session files.

### 4. Portability
- `mcpServerCommand()` now uses `process.execPath` (not a bare `"node"`) + `CONTINUUM_MCP_SERVER_COMMAND`
  env override; the `dist`-relative path is valid for both repo checkout and npm-installed layout.

## Live results (read-only, non-billable)

- `verifyMcpHealth` → **reachable — initialize handshake ok** (real MCP initialize against `continuum-mcp`).
- Codex canonical id (session-meta) → `01a00a15-59c5-7672-8332-c9aad96fad0f` (matches `payload.session_id`).
- `doctor` shows: `MCP auto-configure: not yet decided`; `continuum-mcp: reachable`; per-provider registration/contract.
- `doctor --repair` MCP section → `skipped — MCP auto-configure disabled` (no consent, no mutation).
- Existing Codex servers untouched; `~/.codex/sessions` files unmodified (mtime unchanged).

## Tests

- `npm test` → **52 files / 363 tests passed** (+13: MCP health 5, setup permission 3, session-meta 3, ensure-gating 2).
- `npm run typecheck` clean; `npm run build` clean.
- Coverage: first setup permission, auto-register enabled/disabled gating, idempotency, unrelated MCP preservation,
  real initialize handshake + status classification, stale/missing detection, Codex canonical id + fallback + no-leak,
  Claude deterministic behavior unchanged, handoff/resume regression.

## Tencent health

- Tencent stack untouched and healthy (`tdai-memory-core`/`tdai-proxy`/`tdai-memory-hub` Up healthy).
- No files changed in `TencentDB-Agent-Memory`.

## Risks

1. **MCP `add` not applied live** (only unit-tested + read-only detection) to avoid mutating real user config;
   `continuum mcp-setup` / auto-register-on-launch is the apply path.
2. **"Stale registration" (CLI has an old path while CONTINUUM's current path is valid) is not re-registered**
   — `registerMcpIfMissing` is a no-op when already registered; precise old-path detection needs `mcp get`
   output comparison (deferred to Phase 19). `stale-path` (CONTINUUM's own bin missing) is reported as rebuild-needed.
3. **Codex `session-meta` is proven on 0.147.0**; a future record-shape change needs only the
   `metaRecordType`/`metaPayloadField` data updated, and `last-uuid` fallback still applies.
4. **`session-meta` streams the first JSONL line** (which can be large — `base_instructions`) to extract one field.

## Next recommendation (Phase 19)

1. **Precise stale-registration repair** — read the CLI's registered command via `claude mcp get` /
   `codex mcp get`, compare against `mcpServerCommand()`, and re-register when they differ (updates an old path).
2. **MCP tools/call smoke in `doctor`** — after `initialize`, issue a `tools/list` to confirm the tool surface
   is intact, not just the handshake.
3. **Idempotent auto-register in `resume`/`handoff` already wired**; next, add a `--no-mcp` flag to opt out of the
   pre-launch registration for one run.

Deliberately NOT recommended next: a fourth provider, local/Gemini models, UI, or reworking MCP/provider/session architecture.
