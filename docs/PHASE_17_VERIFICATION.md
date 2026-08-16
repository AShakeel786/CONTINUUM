# Phase 17 — Native CLI MCP Auto-Connect + Session-ID Hardening Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** Auto-discover CONTINUUM MCP for Claude/Codex, and make Claude's native
session id deterministic instead of newest-file discovery.

## Approach (data-driven, no redesign)

MCP registration and deterministic session-id are declared as **data** on provider
profiles, interpreted by generic modules. No provider-id switches in launcher/runtime.

| Piece | Change |
|---|---|
| `providers/types.ts` | `McpRegistrationDescriptor` + `mcp` on launch descriptors; `NativeResumeCapability.sessionIdFlag`; `CliLaunchContext.setSessionId` |
| `providers/adapter.ts` | `sessionArgs()`: resume id → resume args, else `--session-id <id>` when declared |
| `profiles/{claude,deepseek}.ts` | `sessionIdFlag: "--session-id"`; claude+codex declare `mcp: { supported, serverName: "continuum" }` |
| `mcp/registration.ts` | `mcpServerCommand()` / `buildMcpAddArgs()` / `isMcpRegistered()` / `registerMcpIfMissing()` |
| `launcher/launcher.ts` | deterministic `setSessionId` + record; `supportsDeterministicSessionId()` |
| `launcher/cli-contract.ts` | `verifyCliContract()` — read-only, non-billable drift checks |
| `cli/commands/mcp-setup.ts` | idempotent `continuum mcp-setup` |
| `cli/commands/doctor.ts` + `cli/index.ts` | surface MCP + session-contract status |

## MCP result

- Generated command (secret-free): `claude mcp add continuum -- node <abs>/dist/mcp/bin.js` (and `codex`).
- Reuses the existing `continuum-mcp` stdio server — no new server.
- Idempotent: `registerMcpIfMissing` adds only when absent; never rewrites unrelated
  user MCP servers (the CLI's own `mcp add` appends).
- Live (read-only): `isMcpRegistered` → false for both; existing Codex servers
  `computer-use` / `node_repl` untouched. `mcp add` NOT run live (avoids mutating user config).
- `doctor` surfaces `-- claude MCP: continuum-mcp not registered (run: continuum mcp-setup)`.

## Deterministic Claude session identity

- Claude/DeepSeek now launch fresh sessions with `--session-id <continuum-session-id>`
  and record that id deterministically (no newest-file discovery).
- Resume uses `--resume <id>` (resume precedence over `--session-id`).
- Codex has no `--session-id`, so it keeps the safe store-scan fallback (unchanged).
- Backward-compatible fallback preserved: no stored id + no flag → empty args → brief.

## Live CLI contract checks (read-only, non-billable)

- `verifyCliContract` → **Claude: OK (`--resume`, `--session-id`)**; **Codex: OK (`resume`)**.
- Fails clearly ("CLI drift: … not found in `<cli> --help`") on future flag renames/removals.

## Tests

- `npm test` → **51 files / 350 tests passed** (+14: registration 6, cli-contract 4,
  deterministic session-id / precedence, Codex fallback).
- `npm run typecheck` clean; `npm run build` clean.
- Coverage: MCP registration/detection/idempotency/no-overwrite/no-secrets, deterministic
  Claude resume + `--session-id`, Codex fallback, session handoff/resume, CLI drift failure.

## Tencent health

- Tencent stack untouched and healthy (`tdai-memory-core`/`tdai-proxy`/`tdai-memory-hub` Up healthy).
- No files changed in `TencentDB-Agent-Memory`.

## Risks

1. **MCP `add` not applied live** (only unit-tested + read-only detection) to avoid mutating
   the user's real Claude/Codex config; the user-facing `continuum mcp-setup` is the apply step.
2. **Deterministic `--session-id` uses the CONTINUUM session UUID** — an interrupted launch can
   leave a recorded id whose Claude session never existed; `--resume <id>` then falls back
   gracefully (resume brief still applies).
3. **`mcpServerCommand()` absolute path** (`dist/mcp/bin.js`) assumes the project stays where
   `dist/` was built; relocating without rebuild would stale the path.
4. **Codex still uses the `last-uuid` store-scan** (no `--session-id`), keeping the best-effort heuristic.

## Next recommendation (Phase 18)

1. **Auto-register MCP at launch** (auto-`mcp add` on first `continuum launch` when missing, or a
   `--mcp` flag) so discovery is truly automatic, not a separate `mcp-setup` step.
2. **MCP connectivity health in `doctor`** — actually run the MCP `initialize` handshake against
   the registered server, not just "registered".
3. **Codex canonical-id capture** — read Codex's session store id field directly to replace the
   `last-uuid` filename heuristic when a cleaner probe is available.

Deliberately NOT recommended next: a fourth provider, local/Gemini models, UI, or reworking
provider/session architecture.
