# Phase 16 — Native CLI Session Continuity Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** A generic native-session bridge so same-provider resume/handoff continues
the provider's own CLI session (when supported), instead of only injecting a resume brief.

## Approach (data-driven, no provider-id switches)

Native resume is declared as **data** on each provider profile, and interpreted by the
generic adapter + launcher. Nothing branches on provider id in launcher/runtime.

| Piece | Change |
|---|---|
| `providers/types.ts` | `NativeResume`/`NativeSessionStore`/`NativeResumeDescriptor`; `nativeResume` on both CLI launch descriptors; `CliLaunchContext.resumeNativeSessionId` |
| `providers/adapter.ts` | `resumeArgs()` builds `--resume <id>` (flag) or `resume <id>` (subcommand) from declared data |
| `profiles/{claude,deepseek,codex}.ts` | declare resume shape + session store |
| `session/types.ts` | `TaskSession.nativeSessionIds?: Record<string,string>` |
| `session/manager.ts` | `recordNativeSessionId()` |
| `launcher/launcher.ts` | same-provider resume decision; passes id; returns `nativeResume`; `captureNativeSessionId`/`recordNativeSessionId` |
| `launcher/native-session.ts` | `findRecentNativeSessionId()` — generic, read-only, best-effort discovery |
| `cli/commands/launch.ts` | records id after spawn; surfaces `Resuming <provider> native session <id>` |

## Resume shapes (live-verified, non-billable)

- Claude native: `claude --resume <id>` (`-r, --resume [value]`, flag).
- Codex native: `codex resume <id>` (`resume [SESSION_ID]`, subcommand).
- DeepSeek proxy-routed: `claude --resume <id>` (real CLI is Claude Code — same flag semantics).

## Live discovery result (read-only, no billing, no writes)

- Claude recent native id: `a4fff118-eab0-4525-97e3-0c55a0e169d5`
- Codex recent native id: `01a00a15-59c5-7672-8332-c9aad96fad0f` (last-uuid extracted from `rollout-…` filename)

## Fallback behavior

- No stored native id → no resume args, no `nativeResume` → fresh native session + existing resume brief.
- Provider without a declared store / capture failure → `undefined` → safe fallback (never crashes, never fabricates an id).
- Handoff to a different provider starts a **fresh** target-native session (no resume args) while preserving the CONTINUUM task; the source provider's native id is retained for a later handoff-back.

## Tests

- `npm test` → **49 files / 336 tests passed** (+15: `native-resume.test.ts` 5, `native-session-bridge.test.ts` 10).
- `npm run typecheck` clean; `npm run build` clean.
- Coverage: first launch stores id, same-provider resume (codex subcommand + claude flag), Claude→Codex and Codex→Claude handoff (fresh target + task preserved + source id retained), missing-id fallback, discovery (basename/last-uuid), no file-content read / no secret leakage.

## Tencent health

- Tencent stack untouched and healthy (`tdai-memory-core`/`tdai-proxy`/`tdai-memory-hub` Up healthy).
- No files changed in `TencentDB-Agent-Memory`.

## Risks

1. **Capture heuristic is best-effort** ("newest session file at/after launch time"). Concurrent sessions could race; guarded and falls back safely (better than resuming the wrong conversation).
2. **DeepSeek store path** (`~/.claude-tencent/projects`) is an assumption tied to the existing relative-`configDirName` quirk; if capture returns undefined there, resume still falls back to the brief.
3. **Codex `last-uuid` extraction** depends on the `rollout-…-<uuid>.jsonl` filename format; a future Codex change needs only the `idFrom` strategy updated.
4. **First-ever launch has no id** (fresh session + brief) until a capture succeeds — correct by design.

## Next recommendation (Phase 17)

1. **Native CLI MCP auto-connect (config, not code).** Generate `codex mcp add` / Claude MCP snippets so a launched agent auto-connects to `continuum-mcp`; surface in `continuum providers`/`doctor`.
2. **Deterministic capture for Claude.** Use Claude's `--session-id <continuum-session-id>` so the native id equals the CONTINUUM id (removes the newest-file heuristic for Claude); keep Codex's store-scan capture as the fallback.
3. **Non-billable launch-plan smoke tests** against the real CLIs (extend the resume-shape check already done) to catch the next contract drift before it ships.

Deliberately NOT recommended next: a fourth provider, local/Gemini models, UI, or reworking handoff/session architecture.
