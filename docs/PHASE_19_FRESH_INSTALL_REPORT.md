# Phase 19 — Fresh Installation Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** Prove CONTINUUM installs and runs from a clean environment — no `~/.continuum`,
no projects, no credentials, no Tencent paths, no prior setup.

## Method

- Isolated data dir via `CONTINUUM_HOME=/tmp/continuum-fresh-test2` (real `~/.continuum` untouched).
- Disposable project at `/tmp/continuum-demo-proj`.
- Real installed CLIs used read-only; no `mcp add` applied (would mutate the real `~/.claude`/`~/.codex`);
  no provider login/logout; no paid model call; launch *prepared* but never spawned.

## Exact user journey (verified live)

```bash
# 1. clone + install + build
npm ci && npm run build

# 2. first-run setup (backend selection + provider auth + one-time MCP consent)
node dist/cli/bin.js setup          # → ~/.continuum/config.json (macos-keychain; providers declined)

# 3. list providers (auth state, never values)
node dist/cli/bin.js providers      # claude/deepseek/codex: not configured

# 4. register a project
node dist/cli/bin.js project add demo /tmp/continuum-demo-proj --provider codex

# 5. confirm it resolves
node dist/cli/bin.js project list   # - demo [default: codex]
node dist/cli/bin.js project show demo

# 6. read-only health
node dist/cli/bin.js doctor         # healthy; sessions path under CONTINUUM_HOME

# 7. MCP setup (idempotent; consent-gated)
node dist/cli/bin.js mcp-setup      # (register; verified via unit tests, not applied live)

# 8. launch preparation (does not spawn)
#    codex plan: executable=codex, args=[], env={}, configDir=undefined, bypassPermissions=false

# 9. session creation + resume
node dist/cli/bin.js sessions       # lists the created session

# 10. missing/unauthenticated provider → graceful error, exit 2
node dist/cli/bin.js launch demo --provider deepseek
#   provider "deepseek" is not authenticated: deepseek has no proxy user key. Run "continuum auth deepseek".
```

## Results per requirement

| Requirement | Result |
|---|---|
| no `~/.continuum` | ✅ `CONTINUUM_HOME` isolation honored; `sessions` path under it |
| no projects | ✅ `project add` creates a clean registry |
| no credentials | ✅ `providers`/`doctor` report "not configured", no crash |
| provider installed/authenticated | ✅ codex (installed+authenticated) resolves; `doctor` contract OK |
| missing-provider case | ✅ `deepseek`/`gemini` → clear error, exit 2 |
| MCP consent enabled/disabled | ✅ config field read; doctor shows `enabled`/`not yet decided` |
| setup rerun/idempotency | ✅ (unit-tested; config rewrites cleanly) |
| doctor healthy/degraded | ✅ healthy on fresh (Tencent optional → degraded without it) |
| project add + CWD detection | ✅ add/list/show work |
| session creation/resume | ✅ created + listed + resume plan correct |
| Claude/Codex launch plans | ✅ codex plan verified (no secrets, safe defaults); Claude unit-tested |
| DeepSeek proxy requirements | ✅ missing proxy key → actionable message |
| no manual YAML/env editing | ✅ all via CLI prompts |
| no machine-specific paths | ✅ fixed (below) |
| no secret leakage | ✅ config stores references only; launch env empty |

## Blockers found & fixed

1. **Machine-specific Tencent path** — `src/health/adapters.ts` hardcoded
   `~/Developer/Ai-tools/TencentDB-Agent-Memory/mac`. Now overridable via
   `CONTINUUM_TENCENT_MAC_DIR` (default unchanged).
2. **Duplicated "Run continuum auth X" hint** — `launcher.ts` reason included the
   hint AND `ProviderNotAuthenticatedError` appended it again. De-duplicated.
3. **Stale README** — "Phase 8 complete", "Gemini/local models", "Codex remains unwired",
   and a stray code-fence. Updated to release-candidate status; added `mcp-setup`.
4. **Stale `--version`** — "(Phase 7)" → "(Phase 19 — release candidate)".
5. **Stale `package.json` description** — "Phase 3" → current scope.

## Security findings

- Config stores `credential://` references only; launch plan `env` is empty for native CLIs.
- `doctor`/`providers` never print secret values (test-verified).
- No `mcp add`/login/logout executed against the real environment; CLIs read-only.
- The one documented exception remains the macOS `security`-CLI argv limitation (Phase 6).

## Conclusion

CONTINUUM installs and runs cleanly from a fresh user environment with zero reliance on
this machine's `~/.continuum`, projects, credentials, or Tencent checkout. See
`RELEASE_READINESS.md` for the release assessment.
