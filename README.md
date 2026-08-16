# CONTINUUM

A multi-agent development runtime: orchestration across agents, seamless mid-task handoff, shared persistent memory, project isolation, prompt/context-caching optimization, and support for Claude Code, DeepSeek, and Codex — through a common provider and tool layer.

## Status: release candidate (Phase 19)

CONTINUUM is a working multi-agent runtime with three real providers
(Claude Code, DeepSeek via the Tencent proxy, and Codex), durable session
state with mid-task handoff, a native-session bridge (resume the provider's
own CLI session), a provider-independent MCP server, and a health/recovery
layer (`doctor --repair`). See `docs/RELEASE_READINESS.md` for the release
assessment and `docs/PHASE_19_FRESH_INSTALL_REPORT.md` for the clean-room
install verification.

## Quick start

```bash
npm ci            # install dev + runtime deps
npm run build     # compile to dist/
node dist/cli/bin.js setup            # first-run onboarding (backend + provider auth + MCP consent)
node dist/cli/bin.js project add <name> <path> --provider claude   # register a project
node dist/cli/bin.js launch [<proj>]  # resolve project → provider → session → spawn
node dist/cli/bin.js resume <session> # resume (stale-worktree safe; resumes the provider's native session)
node dist/cli/bin.js handoff <session># hand off to an authenticated agent (never auto-selects)
node dist/cli/bin.js sessions         # list/archive recent sessions
node dist/cli/bin.js doctor           # read-only health report (exit 0 healthy / 1 unhealthy)
node dist/cli/bin.js mcp-setup        # idempotently register CONTINUUM MCP with Claude/Codex
node dist/cli/bin.js mcp              # run the MCP server (JSON-RPC over stdio)

# add an OpenAI/Anthropic-compatible API provider (manifest under ~/.continuum/providers/)
node dist/cli/bin.js provider add --id grok --protocol openai-compatible --base-url https://api.x.ai/v1 --auth api-key --env XAI_API_KEY --model grok-3
node dist/cli/bin.js provider list
```

Credentials live in `~/.continuum/` (or `$CONTINUUM_HOME`); config and project
registry store references only. On macOS the native Keychain backend is used
automatically (read `PHASE_6_SECURITY_REPORT.md` for the one documented
`security`-CLI argv limitation). The Tencent memory stack (Docker
`tdai-memory-core`/`tdai-proxy`/`tdai-memory-hub`) is optional — without it,
CONTINUUM degrades to local session context only.

## Status: Phase 6 complete (onboarding & auth)

**Phase 6 turns CONTINUUM into a tool a fresh machine can adopt** — a `continuum` CLI (`setup` / `providers` / `auth` / `doctor`) that walks a new user through credential onboarding, stores secrets in an OS-native backend (macOS Keychain / Windows DPAPI / Linux Secret Service, with an AES-256-GCM encrypted-file fallback) and records only `credential://` references in config — never values. Auth is data-driven (Claude: API + CLI; DeepSeek: API via masked prompt), no provider-specific switches, no manual `.env`/YAML editing, no Windows paths or Tencent project-registry assumptions. See `docs/PHASE_6_ONBOARDING_ARCHITECTURE.md`, `docs/PHASE_6_SECURITY_REPORT.md`, `docs/PHASE_6_VERIFICATION.md`, and `docs/PHASE_7_ENTRY_CRITERIA.md`.

## Status: Phase 5 complete (durable session state + agent handoff prototype)

Phase 1 audited the existing [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) deployment at `C:\Users\arsla\Documents\Ai-tools\TencentDB-Agent-Memory` — the system currently used to launch Claude Code / DeepSeek / Codex sessions for 8 real projects — to determine what becomes CONTINUUM's memory/context infrastructure layer, what needs refactoring, and what's missing entirely. Phase 2 (+ 2.1) then closed the security/stability findings that audit surfaced, rebuilt and redeployed the affected Docker images, and verified the real live deployment still works with zero regressions. Phase 3 built the provider registry (`src/providers/`), proven with Claude and DeepSeek. Phase 4 built the context pipeline (`src/context/`, `src/token/`, `src/cache/`, `src/rendering/`) everything else depends on, plus a tested harness proving native Claude can receive real Tencent Memory (`src/native-claude/`).

**Phase 5 built what R-18 found completely missing: a real agent-handoff mechanism.** `src/session/` is a durable, versioned `TaskSession` — atomic writes, checksum-verified corruption recovery, optimistic-concurrency conflict protection, all proven against a real simulated process restart — with explicit APIs (`addCompletedWork`, `recordDecision`, `recordToolActivity`, ...) that update state *during* work, not just at session end. `src/handoff/` is the prototype itself: a synchronous flush that provably never blocks on Tencent's async memory capture (tested against a `fetch` that never resolves), producing a token-budgeted `HandoffPackage` — routed through the real Phase 3 Provider Registry with **no automatic provider selection** (a two-call API is the entire enforcement mechanism), rendered through the real Phase 4 rendering pipeline. Claude→DeepSeek, DeepSeek→Claude, and same-provider restart all work through the identical mechanism. A receiving agent gets an explicit "this is an existing task, do not re-audit" block that's structurally un-droppable (it reuses the Token Manager's own critical-instructions protection) and includes stale-repo-state warnings when the git worktree has materially changed since the state was recorded. See `docs/PHASE_5_SESSION_ARCHITECTURE.md`, `docs/PHASE_5_HANDOFF_REPORT.md`, `docs/PHASE_5_VERIFICATION.md`, and `docs/PHASE_6_ENTRY_CRITERIA.md` for what's next.

**Addendum — provider pricing-window awareness** (`src/pricing/`): Session State now tracks DeepSeek's peak/off-peak pricing windows (config-driven, not hardcoded — see `docs/PRICING_AWARENESS.md`), notifies once (never duplicated across a restart) before and at a peak-pricing transition, and can surface — never auto-trigger — a handoff suggestion through the existing Phase 5 provider-selection workflow.

Read the docs:

| Doc | Contents |
|---|---|
| [`docs/PHASE_1_EXISTING_SYSTEM_AUDIT.md`](docs/PHASE_1_EXISTING_SYSTEM_AUDIT.md) | Component-by-component audit of the current Tencent system, verified by reading source. |
| [`docs/RUNTIME_FLOW.md`](docs/RUNTIME_FLOW.md) | Traced execution flow: launcher → project selection → agent → proxy → model API → memory → response. |
| [`docs/RISKS_AND_TECH_DEBT.md`](docs/RISKS_AND_TECH_DEBT.md) | 33 findings, severity-ranked, from the Phase 1 audit. |
| [`docs/TENCENT_MIGRATION_MAP.md`](docs/TENCENT_MIGRATION_MAP.md) | Per-module: reuse as-is, refactor, build new, or discard. |
| [`docs/CONTINUUM_ARCHITECTURE.md`](docs/CONTINUUM_ARCHITECTURE.md) | Proposed module design, with two refinements to the original skeleton driven by audit findings. |
| [`docs/PHASE_2_RECOMMENDATIONS.md`](docs/PHASE_2_RECOMMENDATIONS.md) | Originally-proposed Phase 2 scope — this is what Phase 2 actually executed. |
| [`docs/PHASE_2_SECURITY_STABILITY_REPORT.md`](docs/PHASE_2_SECURITY_STABILITY_REPORT.md) | What was fixed, how it was verified (including a real bug caught and corrected mid-phase), before/after status, pass/fail. |
| [`docs/PHASE_2_TEST_MATRIX.md`](docs/PHASE_2_TEST_MATRIX.md) | Every verification item, method, and result — unit tests and live-container tests against the real deployment. |
| [`docs/TENCENT_SECURITY_POSTURE.md`](docs/TENCENT_SECURITY_POSTURE.md) | Current-state security snapshot: what's closed, what's contained-not-eliminated, what's still out of scope. |
| [`docs/PHASE_3_ENTRY_CRITERIA.md`](docs/PHASE_3_ENTRY_CRITERIA.md) | What's satisfied, what decisions are still needed from you, and the recommended Phase 3 starting point. |
| [`docs/PHASE_2_1_BASELINE_CLOSURE.md`](docs/PHASE_2_1_BASELINE_CLOSURE.md) | Closed the remaining baseline gaps before Phase 3: Phase 2 commit, the Windows `python3`→`node` registry-parsing fix, and completing the R-8 upstream-key migration on all 8 live proxy configs. |
| [`docs/PHASE_3_PROVIDER_ARCHITECTURE.md`](docs/PHASE_3_PROVIDER_ARCHITECTURE.md) | The provider registry/adapter design (`src/providers/`), why `cliLaunch` is modeled separately from direct-call `protocol`/`auth`, and the native Anthropic `LLMRunner` added to MemoryCore. |
| [`docs/PHASE_3_VERIFICATION.md`](docs/PHASE_3_VERIFICATION.md) | Every test the brief required, what covers it, and the Tencent-deployment regression check. |
| [`docs/PHASE_4_ENTRY_CRITERIA.md`](docs/PHASE_4_ENTRY_CRITERIA.md) | What Phase 3 revealed but deliberately didn't build, decisions needed from you, and the recommended Phase 4 starting point (Context Manager consolidation). |
| [`docs/PHASE_4_CONTEXT_ARCHITECTURE.md`](docs/PHASE_4_CONTEXT_ARCHITECTURE.md) | The `ContextEnvelope` design, why it's blocks not strings, where Tencent Memory data actually comes from (and a real gap found in the Gateway's own `/recall` endpoint along the way), and the `StandaloneLLMRunner` fix. |
| [`docs/PHASE_4_CACHE_TOKEN_REPORT.md`](docs/PHASE_4_CACHE_TOKEN_REPORT.md) | Token Manager and Prompt Cache Intelligence detail — exactly which numbers are real/provider-verified vs. estimated, field-by-field, for both Claude and DeepSeek. |
| [`docs/PHASE_4_VERIFICATION.md`](docs/PHASE_4_VERIFICATION.md) | Every test the brief required, what covers it, the Tencent regression check, and what a live (but empty-scope) run against the real MemoryCore Gateway did and didn't prove. |
| [`docs/PHASE_5_ENTRY_CRITERIA.md`](docs/PHASE_5_ENTRY_CRITERIA.md) | What Phase 4 revealed but deliberately didn't build, decisions needed from you, and the recommended Phase 5 starting point (agent/task session-state layer). |
| [`docs/PHASE_5_SESSION_ARCHITECTURE.md`](docs/PHASE_5_SESSION_ARCHITECTURE.md) | The `TaskSession` schema, durability guarantees (atomic writes, corruption recovery, optimistic concurrency), git fingerprinting, and the new precise per-block cache-invalidation diff. |
| [`docs/PHASE_5_HANDOFF_REPORT.md`](docs/PHASE_5_HANDOFF_REPORT.md) | The handoff flow end to end — synchronous flush semantics, what's in a `HandoffPackage`, why the resume block is un-droppable "for free," and the no-auto-pick provider selection guarantee. |
| [`docs/PHASE_5_VERIFICATION.md`](docs/PHASE_5_VERIFICATION.md) | Every test the brief required, what covers it, the Phase 4 baseline commit detail, and the Tencent regression check. |
| [`docs/PHASE_6_ENTRY_CRITERIA.md`](docs/PHASE_6_ENTRY_CRITERIA.md) | What Phase 5 revealed but deliberately didn't build, decisions needed from you, and the recommended Phase 6 starting point (MCP wrapper). |
| [`docs/PHASE_6_ONBOARDING_ARCHITECTURE.md`](docs/PHASE_6_ONBOARDING_ARCHITECTURE.md) | The onboarding/auth design: credential backends, `credential://` references, masked prompts, the `continuum` CLI, and the fresh-machine guarantee. |
| [`docs/PHASE_6_SECURITY_REPORT.md`](docs/PHASE_6_SECURITY_REPORT.md) | Phase 6 security posture — every protection and limit stated plainly, including the one macOS `security`-CLI argv exception. |
| [`docs/PHASE_6_VERIFICATION.md`](docs/PHASE_6_VERIFICATION.md) | Every test the brief required, what covers it, the live macOS Keychain disposable check, and what was NOT (and why). |
| [`docs/PHASE_7_ENTRY_CRITERIA.md`](docs/PHASE_7_ENTRY_CRITERIA.md) | What Phase 6 revealed but deliberately didn't build, decisions needed from you, and the recommended Phase 7 starting point. |
| [`docs/PHASE_7_LAUNCHER_ARCHITECTURE.md`](docs/PHASE_7_LAUNCHER_ARCHITECTURE.md) | The cross-platform launcher design: project registry, launch/resume/handoff flow, safe-by-default permissions, MemoryCore degrade, and the one documented DeepSeek-proxy-key seam. |
| [`docs/PHASE_7_VERIFICATION.md`](docs/PHASE_7_VERIFICATION.md) | Every test the brief required, what covers it, the CLI smoke test, and what was NOT (and why). |
| [`docs/PHASE_8_ENTRY_CRITERIA.md`](docs/PHASE_8_ENTRY_CRITERIA.md) | What Phase 7 revealed but deliberately didn't build, decisions needed from you, and the recommended Phase 8 starting point (MCP wrapper). |
| [`docs/PHASE_7_1_CLOSURE.md`](docs/PHASE_7_1_CLOSURE.md) | Phase 7.1 launcher UX closure: proxy credential, provider prompt, session listing, provider-change handoff, upstream-key non-leak. |
| [`docs/PHASE_8_MCP_ARCHITECTURE.md`](docs/PHASE_8_MCP_ARCHITECTURE.md) | The MCP tool layer: dependency-free JSON-RPC-over-stdio server, memory + session tools wrapping existing modules, read/write split, isolation and secret safety. |
| [`docs/PHASE_8_VERIFICATION.md`](docs/PHASE_8_VERIFICATION.md) | Every test the brief required, what covers it, the live stdio smoke test, and what was NOT (and why). |
| [`docs/PHASE_9_ENTRY_CRITERIA.md`](docs/PHASE_9_ENTRY_CRITERIA.md) | What Phase 8 revealed but deliberately didn't build, and the recommended Phase 9 starting point (combined live-verification). |
| [`docs/PRICING_AWARENESS.md`](docs/PRICING_AWARENESS.md) | The Phase 5 addendum: config-driven peak/off-peak pricing windows, a real boundary bug found and fixed via testing, deduplicated notifications, and the non-automatic handoff-suggestion hook. |

## Relationship to Tencent

TencentDB Agent Memory is **not discarded** — it becomes CONTINUUM's memory/context infrastructure layer. The audit found its memory engine (`MemoryCore`, the L0→L3 pipeline, storage backends, host-adapter architecture) is cleanly host-agnostic by design and directly reusable. The proxy/context-injection layer (`MemoryProxy`) is ~70% provider-agnostic and reusable as CONTINUUM's context/observability middleware, with the Claude-Code/DeepSeek-specific parts isolated to a small, well-factored adapter surface.

What the audit found was genuinely missing — and what CONTINUUM adds on top of Tencent's memory layer — is: mid-task agent handoff, a unified context-assembly path, a real multi-provider abstraction, and an MCP/tool layer (zero MCP code exists anywhere in the current system). Phase 3 built the provider abstraction, proven with Claude and DeepSeek (`src/providers/`), later extended with Codex (Phase 15) — adding a further provider is now a matter of adding a profile, not rewriting routing logic. Phase 4 built the unified context-assembly path (`src/context/`) and proved, via a tested harness, that native Claude sessions — memory-blind today in the real launcher — can receive real Tencent Memory through it (`src/native-claude/`). Phase 5 built mid-task agent handoff (`src/session/`, `src/handoff/`) — R-18's "no agent-handoff mechanism exists" — as a durable session-state layer plus a working handoff mechanism, later extended to Claude/DeepSeek↔Codex (Phase 15) and native-session continuity (Phase 16). The MCP/tool layer (Phase 8) and its auto-connect/health hardening (Phases 17–18) complete the runtime.

## Canonical repo

`https://github.com/AShakeel786/CONTINUUM`
