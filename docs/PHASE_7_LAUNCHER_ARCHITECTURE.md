# Phase 7 — Cross-Platform Launcher Architecture

Phase 7 makes `continuum` the daily launcher that wires together the systems
built in Phases 3–6. It adds **orchestration only** — a project registry and a
launcher that *call* the existing Provider Registry, credential/auth, Context
Manager, session state, handoff, and pricing systems. Nothing here re-implements
what those modules already do.

## What's new

| Module | Role |
|---|---|
| `src/registry/` | `ProjectRegistry` — CRUD, aliases, CWD detection, default provider/model. Persisted to `~/.continuum/projects.json`. |
| `src/launcher/` | `Launcher` — resolve project → provider → session → launch; resume with stale-worktree protection; provider-usability check; MemoryCore degrade. |
| `src/launcher/spawn.ts` | The single `spawnCli` boundary — inherits stdio, applies the plan's env. |
| `src/cli/commands/project.ts` | `continuum project add/remove/list/show`. |
| `src/cli/commands/launch.ts` | `continuum launch [<proj>] [--provider] [--task]`, `resume <session>`, `handoff <session>`. |
| `src/cli/commands/launcher-context.ts` | Builds the full launcher dependency graph from the same primitives. |

## The launch flow (all existing subsystems, wired once)

```
project (name/alias/CWD)   →  ProjectRegistry
provider (default/override) →  ProviderRegistry + AuthVerifier/CliAuthManager
   → usability gate: CLI installed + authenticated, OR API key present
session (new / resume)     →  SessionManager (durable TaskSession)
   → resume: git-fingerprint comparison → stale-worktree flag
context                    →  buildContextEnvelope (+ MemoryCore when available)
   → allocateBudget → renderContextForProvider
launch plan                →  ProviderAdapter.buildCliLaunchPlan + auth env
spawn                      →  spawnCli (stdio inherit)
```

## Safe-by-default, explicit opt-in bypass

`Launcher.prepareLaunch(..., { permissionMode })` accepts `"safe"` or `"bypass"`.
`safe` never injects a permission-bypass flag; `bypass` is only ever the result
of the caller passing `--bypass-permissions` / `--dangerously-bypass`. The
`LaunchPlan.bypassPermissions` flag is informational; the spawn boundary makes
no permission decision of its own.

## Handoff: ask which authenticated agent, never auto-select

`continuum handoff <session>`:

1. `launcher.listAuthenticatedProviders()` — filters the Provider Registry down
   to agents that are **both installed and authenticated** (Claude: CLI status;
   DeepSeek: stored API key).
2. `HandoffManager.prepareHandoff` / `finalizeHandoff` (Phase 5, unchanged) —
   the provider must be supplied explicitly; there is no "auto" mode.
3. The same `TaskSession` is preserved, so the receiving agent gets the
   protected resume block ("do not re-audit") instead of starting over.

## Peak-pricing handoff prompt

`continuum launch` calls `PricingAwarenessService.check(sessionId)` before
spawning. When a peak/pre-peak event fires for the active provider,
`suggestHandoffOnPeakEvent` (Phase 5) packages the message with the list of
available authenticated agents. The launcher **prints** this — it never
auto-handsoffs. The human then runs `continuum handoff <session>` to act on it.

## MemoryCore: use when available, degrade clearly when not

The launcher accepts an optional `MemoryCoreGatewayConfig` (resolved from
`CONTINUUM_MEMORY_CORE_*` env vars). When present, context is assembled from a
real read-only Gateway fetch; when the fetch fails or is absent, the launch
still succeeds on local session context only, and sets an explicit
`memoryCoreNote` (surfaced to the user) so the degradation is never silent.

## Cross-platform, no legacy dependency

- Project paths are resolved via `path.resolve` (host separators), never a
  hardcoded `C:\` or a specific machine path.
- No `.ps1` / Tencent launcher is referenced; provider launch mechanics come
  from `ProviderAdapter.buildCliLaunchPlan`, which already encodes native vs
  proxy-routed per provider as data.
- Sessions live under `~/.continuum/sessions/` (or `$CONTINUUM_HOME`), keyed by
  `TaskSession` id.

## One known gap (documented, not hidden)

Launching **DeepSeek** through the proxy requires `CONTINUUM_TENCENT_PROXY_USER_KEY`
— a Tencent-proxy-local secret that Phase 6's credential backend does not yet
own (the proxy holds DeepSeek's upstream key server-side). A DeepSeek *direct*
API call works via the stored `DEEPSEEK_API_KEY`, but a DeepSeek *CLI* launch
via the proxy fails with a clear `ProviderAuthError` until that proxy key is
provided. This is a real integration seam flagged for a follow-up, not silently
papered over.
