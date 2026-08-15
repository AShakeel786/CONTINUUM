# Tencent → CONTINUUM Migration Map

How each audited component maps onto the CONTINUUM architecture (see `CONTINUUM_ARCHITECTURE.md`). Nothing here has been implemented — this is a plan. Reuse claims are based on the Phase 1 audit; each should be spot-verified again at implementation time since this codebase is under active development upstream.

Legend: ✅ Reuse as-is/near-as-is · 🔧 Refactor (keep the concept/interface, rework the implementation) · 🆕 Build new (nothing usable exists today) · ⛔ Do not carry forward

---

## Runtime Core

| Tencent source | Disposition | Notes |
|---|---|---|
| `MemoryCore/src/core/tdai-core.ts` + `src/core/types.ts` (`HostAdapter`/`RuntimeContext`/`LLMRunnerFactory`) | ✅ | Explicitly host-agnostic hexagonal design. This is the strongest reuse candidate in the whole repo — CONTINUUM's Runtime Core can treat `TdaiCore` as a library dependency rather than rewriting memory orchestration. |
| `MemoryCore/src/gateway/server.ts` | ✅ (as integration surface) | Prefer integrating via this HTTP Gateway (as Hermes v1 already does) over re-embedding `TdaiCore` in-process — keeps CONTINUUM decoupled from MemoryCore's internal versioning. |
| Raw `docker run` + bash orchestration (`deploy/global-images/*.sh`) | 🔧 | Keep the *semantics* (`wait_healthy`, `require_vars` fail-fast-with-full-list) as design inspiration; replace the mechanism with real compose/orchestration owned by CONTINUUM. |

## Agent Router

| Tencent source | Disposition | Notes |
|---|---|---|
| `windows/launch-tencent-claude.ps1` agent-selection `switch` (3 hardcoded agents) | 🔧 | Concept (menu → provider) is fine; implementation is a hardcoded switch statement that doesn't scale past 3 providers. Needs a data-driven provider-profile table. |
| `MemoryProxy` `upstream.agents[<name>]` config table | ✅ | Already a clean, provider-agnostic routing primitive — different agent CLIs hit different upstream URLs/keys via config, not code. Good template for CONTINUUM's router config shape. |
| `MemoryProxy/src/agent-adapters/{claude-code,codebuddy,default}.ts` | ✅ | Clean `AgentAdapter` interface + factory + safe unknown-client fallback. Extend with new adapters per CLI rather than rewriting the pattern. |

## Agent Handoff

| Tencent source | Disposition | Notes |
|---|---|---|
| — | 🆕 | **Nothing in the audited system does this.** Today, "handoff" is: close one CLI, open another against the same directory, hope L0-L3 memory captured enough context (and per R-17, two of three agent paths capture nothing at all). CONTINUUM needs to design an explicit handoff package (session summary, open task state, working memory) independent of the lossy/async L0-L3 pipeline. |
| `MemoryCore/src/core/state/*` (`IStateBackend`, `LocalStateBackend`) | 🔧 | Useful as the *memory-pipeline* state layer underneath handoff, but it only tracks capture-buffer/timer bookkeeping — not full agent/task/provider state. CONTINUUM's handoff state needs to be broader than this. |

## Context Manager

| Tencent source | Disposition | Notes |
|---|---|---|
| `MemoryCore/src/core/hooks/auto-recall.ts` (stable/dynamic split) | ✅ | The single best-designed piece of context-assembly logic found in the audit — cacheable system-prompt content vs. per-turn user-prompt content, already separated by construction. |
| `MemoryProxy/src/injection/*` (pipeline, registry, provider, per-protocol adapters) | 🔧 | A second, independent context-injection implementation that does **not** share the stable/dynamic split from `auto-recall.ts`. CONTINUUM should standardize on one context-assembly strategy and make every integration path (proxy-based, embedded, HTTP-based) use it — this closes R-16. |
| `MemoryProxy/src/injection/adapters/{anthropic,openai}.ts` | ✅ | Small, well-isolated protocol adapters (where does the system prompt live). Needs one more adapter for any provider with a genuinely different schema (e.g. Gemini's `contents[].parts`). |

## Prompt Cache Intelligence

| Tencent source | Disposition | Notes |
|---|---|---|
| `auto-recall.ts`'s `appendSystemContext`/`prependContext` split | ✅ | The content-side split already exists. What's missing (🆕) is emitting provider-specific cache-control metadata (Anthropic's explicit `cache_control` breakpoints vs. OpenAI's automatic prefix caching) — `auto-recall.ts` produces the split but not the cache directives themselves. |
| `PROXY_DEBUG_DUMP_OUTBOUND_MD5` debug flag (MemoryProxy) | 🔧 | Existing debug tooling for verifying cache-hit-relevant byte-identical prompts — a useful diagnostic pattern to keep for CONTINUUM's own cache-hit verification. |

## Token Manager

| Tencent source | Disposition | Notes |
|---|---|---|
| `applyRecallBudget()` in `auto-recall.ts` (char/count budget, UTF-8-safe truncation) | ✅ | Solid, reusable primitive for context-window budgeting. |
| MemoryProxy Redis-based rate-limiting (per spaceId × model TPM/QPM) | ✅ | Separate concern from context budgeting (this is request-throughput limiting, not context-size limiting) but a reusable component as-is. |

## Tencent Memory

| Tencent source | Disposition | Notes |
|---|---|---|
| `MemoryCore/src/core/*` (L0-L3 pipeline: `l0-recorder.ts`, `record/*`, `scene/*`, `persona/*`) | ✅ | This *is* CONTINUUM's memory/context infrastructure layer, per the original brief — the whole point of Phase 1 was confirming this is reusable, and it is: cleanly separated from any specific host. |
| `src/core/store/*` (SQLite / TCVDB `IMemoryStore`), `src/core/storage/*` (local FS / COS `StorageAdapter`) | ✅ | Generic storage abstractions, swappable backends already supported. |
| `src/adapters/standalone/*` (`StandaloneHostAdapter`, `StandaloneLLMRunner`) | ✅ (as template) | Already has zero OpenClaw dependency — effectively "the CONTINUUM adapter" in spirit. A CONTINUUM-specific `HostAdapter` is likely a thin variant of this (different `RuntimeContext` defaults) rather than a from-scratch build. |
| `src/adapters/openclaw/*` | ⛔ | OpenClaw-runtime-coupled; not meaningful outside an OpenClaw host process. Leave as-is in MemoryCore (don't delete — other consumers may still need it), just don't build on top of it for CONTINUUM. |
| Hermes v1 Python plugin (`hermes-plugin/memory/memory_tencentdb/`) subprocess-supervision mechanics | ✅ (pattern only) | The health-checked-spawn / process-group-kill / watchdog / circuit-breaker / bounded-thread-pool *mechanics* are generic and reusable for CONTINUUM's own sidecar management, independent of Hermes's `MemoryProvider` ABC wrapper around them. |
| `LocalStateBackend` in-memory-only session bookkeeping | 🔧 | Fine for single-process standalone use; flagged (R-16 area) as a durability gap CONTINUUM should be deliberate about if session continuity matters for handoff. |

## Provider Adapters

| Tencent source | Disposition | Notes |
|---|---|---|
| Claude — Anthropic-Messages-API impersonation trick | 🔧 | Works, but is a workaround for "we only have a Claude Code CLI binary." CONTINUUM should have a real provider abstraction (base URL + auth + model mapping) rather than depending on every new provider being shimmed to look like Anthropic's API. |
| Claude — native Anthropic client | 🆕 | Does not exist anywhere in MemoryCore (`StandaloneLLMRunner` is OpenAI-compatible-only). Needed for memory-processing calls to use Claude natively (extended thinking, native prompt caching). Well-scoped: `LLMRunnerFactory`/`LLMRunner` interfaces are already the clean extension point. |
| DeepSeek | ✅ | Already just "an OpenAI-compatible upstream with a couple of quirks" (unsigned `thinking`-block stripping) — proves the adapter pattern works; port the pattern, not necessarily the code. |
| Gemini | 🆕 | Nothing exists. Needs a new `upstream.agents[]` entry (MemoryProxy side) + potentially a new `src/injection/adapters/gemini.ts` if its request schema differs meaningfully from OpenAI/Anthropic shape, + a new `LLMRunner` if MemoryCore should call it directly. |
| Local models | 🆕 | Nothing exists. `node-llama-cpp` appears only as an optional peer dependency allowlist entry in `MemoryCore/pnpm-workspace.yaml` — no actual local-model runner code was found. |

## Tool / MCP Layer

| Tencent source | Disposition | Notes |
|---|---|---|
| — | 🆕 | Confirmed zero MCP code anywhere in `MemoryCore/`. Existing tool exposure (OpenClaw plugin tools, Hermes's bespoke `MemoryProvider` tool schemas) is host-native, not MCP. Building this means wrapping MemoryCore's Gateway REST API (skill/knowledge/memory endpoints) in an MCP server shim — a new, moderate-sized component. |
| `MemoryProxy/src/skill-bridge.ts`, `src/memory/memory-bridge.ts` | 🔧 | The pattern of "let the LLM call tool endpoints through the proxy, with the proxy injecting the real credential server-side so it never appears in the prompt" is a good security pattern worth preserving in whatever MCP shim CONTINUUM builds. |

## Project Registry

| Tencent source | Disposition | Notes |
|---|---|---|
| `windows/tencent-project-registry.json` schema (`name`, `aliases`, `path`, `settingsFile`, `taskId`, `proxyPort`, `containerSlug`) | 🔧 | Generalize: drop Tencent/Claude-specific fields (`settingsFile`, `taskId`), keep the alias/path/port concept, add multi-team/multi-tenant support (today one global `teamId`/`agentId` pair covers all projects), add file locking (R-15). |
| Alias map + CWD auto-detect + interactive-menu resolution pattern (`launch-tencent-claude.ps1`) | ✅ (pattern) | Clean, generalizable "which project am I in" resolution logic — keep the pattern, rebuild the implementation data-driven and cross-platform. |
| `Add-TencentProject.ps1` project-safety fingerprint (git remote/HEAD/file-count check before/after a mutating op) | ✅ | Genuinely good guard-rail pattern; generalize into a reusable component for any operation CONTINUUM performs against a user's project folder, not just registration. |

## Session State

| Tencent source | Disposition | Notes |
|---|---|---|
| `MemoryCore/src/core/state/{types,local-backend}.ts` (`IStateBackend`) | 🔧 | Good base for the *memory-pipeline* slice of session state (buffers, extraction triggers). CONTINUUM needs a broader session-state concept layered on top — active agent, working directory, open task, provider/model in use — so a handoff can restore all of it, not just memory buffers. |
| Redis-backed state (service mode) | ✅ (as option) | Reasonable path to multi-replica/shared session state once CONTINUUM needs it; not deep-audited in Phase 1. |

## Health / Recovery

| Tencent source | Disposition | Notes |
|---|---|---|
| `Start-TencentStack` / `Repair-ProjectProxy` (PowerShell) | 🔧 | Self-healing logic exists but is scattered: PowerShell (launcher), bash (`wait_healthy` in `_lib.sh`), and Python (Hermes watchdog/circuit-breaker) each reimplement health-check/recovery semantics independently, with no shared implementation and at least one confirmed dead-code gap (R-12). CONTINUUM should consolidate this into one implementation used everywhere. |
| Hermes v1 watchdog/circuit-breaker/auto-recovery constants and thread-pool bounding | ✅ (pattern) | Verified to match its own documentation exactly, with sensible named constants and documented rationale (e.g. why recovery cooldown < breaker cooldown). Best-engineered self-healing code in the whole audited system — worth porting the *design*, even in a different language. |
| `wait_healthy()` (`deploy/global-images/_lib.sh`) | 🔧 | Reasonable polling primitive; should be replaced by real orchestrator health-check primitives (compose/K8s) rather than hand-rolled bash, per `PHASE_1_EXISTING_SYSTEM_AUDIT.md` §10. |

## CLI / Launcher

| Tencent source | Disposition | Notes |
|---|---|---|
| `windows/launch-tencent-claude.ps1` overall UX (registry-driven project + agent selection, interactive fallback) | 🔧 | Keep the UX shape. Rebuild: cross-platform (today Windows/PowerShell-only), data-driven provider table (not a 3-way hardcoded switch), no unconditional permission-bypass flags, centralized credential handling (not per-project plaintext YAML duplication). |
| Env-var sanitization-before-launch pattern | ✅ (pattern) | Good defensive habit; generalize into a proper "provider profile declares which env vars it owns" abstraction rather than one shared big pattern list. |

---

## Explicitly Obsolete / Do Not Carry Forward

- ⛔ Ad hoc "backup by manual copy into the repo tree" practice (`backups/2026-08-09_bypass-all-agents/`, `backups/active/*`) — replace with normal git branches/tags. Already caused a live credential-leak risk (R-1).
- ⛔ `jarvis`-as-magic-string special-casing scattered across 4+ scripts (R-22) — a generalized project registry has no reason to special-case any one project by name.
- ⛔ `MemoryPanel/docker/local/Dockerfile.local` "local mode" build path, which assumes access to a private Tencent npm registry (`@tencent/*` packages) — not usable outside Tencent's internal environment; irrelevant to CONTINUUM's open, multi-provider goal.
- ⛔ `MemoryProxy/src/identity.ts`'s dormant raw-header `recentInspections` buffer (R-9) — remove or hard-redact before any reuse, don't port as-is.
