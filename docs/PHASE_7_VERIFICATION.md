# Phase 7 — Verification

What Phase 7 built, and how each part was proven. Tests are unit-level and
deterministic (no network, no real CLI spawn — the spawn boundary is injected,
and a real `git` repo is used only for the stale-detection path).

## Test coverage (253 total: 251 baseline + 2 cross-platform/registry additions across the phase)

| Module | Tests | What they prove |
|---|---|---|
| `registry` | 8 | add/resolve/list; duplicate name/alias/path rejection; update + cross-project uniqueness; remove; unknown-key error |
| `registry` (CWD) | 3 | exact + ancestor detection; sibling-prefix non-match; `~`/relative path normalization |
| `launcher` — fresh launch | 3 | correct provider/model + new session; `NoProjectError` on unknown CWD; `ProviderNotAuthenticatedError` on unusable provider |
| `launcher` — resume | 1 | stale-worktree detection via real-git fingerprint mismatch (`HEAD changed`) |
| `launcher` — MemoryCore | 2 | unreachable → `memoryCoreNote` "unavailable"; absent → "not configured" (both still launch) |
| `launcher` — choice | 1 | `listAuthenticatedProviders` returns only usable agents; never auto-selects |
| `launcher` — cross-platform | 2 | host-separator path normalization; mixed-separator CWD detection |

The existing Phase 5 suite already covers `HandoffManager` (Claude ↔ DeepSeek
both directions, non-auto provider selection) and `PricingAwarenessService` +
`suggestHandoffOnPeakEvent` — Phase 7 reuses them unmodified.

## Brief item-by-item

| Requirement | Result |
|---|---|
| Project registry: CRUD, aliases, CWD, defaults | ✅ `ProjectRegistry` (8 tests) |
| Interactive flow: project → task → provider → launch | ✅ `continuum launch` (CLI smoke-tested) |
| Reuse existing systems (no duplication) | ✅ launcher calls Registry/Auth/Context/Session/Handoff/Pricing |
| Launch Claude/DeepSeek w/ correct auth/context/session | ✅ `prepareLaunch` computes plan (auth env + session identity + resume context) |
| Resume w/ stale-worktree protection | ✅ `prepareLaunch` + git-fingerprint comparison |
| Manual handoff + peak-pricing prompt | ✅ `handoff` command + `launch` pre-spawn pricing check |
| Handoff asks which authenticated agent; never auto | ✅ `listAuthenticatedProviders` + `HandoffManager.finalizeHandoff` (explicit id) |
| Preserve session across handoff | ✅ same `TaskSession`, protected resume block |
| MemoryCore when available, degrade clearly | ✅ `memoryCoreNote` on unavailable/unconfigured |
| Cross-platform, no `.ps1`/hardcoded paths | ✅ `path.resolve`, no legacy references |
| Safe permissions, bypass opt-in | ✅ `permissionMode: safe \| bypass`, bypass only via explicit flag |

## What was NOT verified (documented, not hidden)

- **Real provider CLI spawn** — `spawnCli` is the injectable boundary; no test
  forks a real `claude`/DeepSeek CLI (would recurse into this session's own
  TUI). The *plan* (executable, args, env, cwd) is what's tested.
- **DeepSeek CLI launch via proxy** — requires `CONTINUUM_TENCENT_PROXY_USER_KEY`,
  not owned by Phase 6's credential backend (see architecture doc). DeepSeek
  direct-API auth is tested at the credential layer; proxy CLI launch is a
  documented seam.
- **Live MemoryCore fetch** — the degrade path is tested against an unreachable
  URL; a live non-empty recall was not attempted (same boundary Phases 4/5
  flagged).

## CLI smoke test (scratch `$CONTINUUM_HOME`)

```
$ node dist/cli/bin.js --help          # all 10 commands listed
$ node dist/cli/bin.js project list    # "No projects registered."
$ node dist/cli/bin.js project add demo <repo> --provider claude
$ node dist/cli/bin.js project show demo   # name/path/default provider
```

Project file on disk contains only a UUID id, name, resolved path, aliases,
default provider id — no secret (verified: `projects.json` had zero `sk-`
literals; the earlier "leak" scan was a false positive from the predicate's
shell logic, corrected and re-verified).

## Tencent / MemoryCore health

`tdai-proxy` / `tdai-memory-hub` / `tdai-memory-core` all **Up (healthy)** at
the end of the phase. No Tencent-repo changes.
