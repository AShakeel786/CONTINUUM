# CONTINUUM Architecture Proposal

**Status: proposal, not implemented.** Everything in this document is a Phase 2+ design target, informed by the Phase 1 audit (`PHASE_1_EXISTING_SYSTEM_AUDIT.md`, `TENCENT_MIGRATION_MAP.md`). Where a module's design leans heavily on a specific audited component, that's cited; otherwise it's new design with no existing precedent in the Tencent codebase.

The brief proposed this skeleton:

```text
CONTINUUM
├── Runtime Core
├── Agent Router
├── Agent Handoff
├── Context Manager
├── Prompt Cache Intelligence
├── Token Manager
├── Tencent Memory
├── Provider Adapters
│   ├── Claude
│   ├── DeepSeek
│   ├── Gemini
│   └── Local Models
├── Tool / MCP Layer
├── Project Registry
├── Session State
├── Health / Recovery
└── CLI / Launcher
```

The audit confirms this shape is fundamentally right — every one of these has either a strong existing analog to build on, or a confirmed gap that justifies a dedicated module. Two refinements are worth making before Phase 2 starts, both driven by concrete audit findings rather than taste:

### Refinement 1 — split "Tencent Memory" into Memory Engine + Context Assembly, explicitly

The audit found **three different, non-shared context-assembly implementations** in the current system (R-16): `MemoryCore`'s OpenClaw-embedded `auto-recall.ts` (prompt-cache-aware), the Hermes v1 Python plugin's flat-blob `prefetch()`, and `MemoryProxy`'s own `src/injection/*` pipeline. If CONTINUUM's "Tencent Memory" box quietly absorbs all three without resolving that, the divergence just moves house. So:

- **Tencent Memory** = the L0-L3 engine, storage backends, and session-state bookkeeping only (maps to `MemoryCore/src/core/*` minus `auto-recall.ts`'s assembly logic).
- **Context Manager** (already in the skeleton) becomes the *single* place that turns raw memory + skills + knowledge into what actually goes in a request, using the stable/dynamic split pattern already proven in `auto-recall.ts`. Every provider path (proxy-routed, embedded, direct-HTTP) calls through Context Manager — none of them re-implement assembly themselves. This directly closes R-16 and R-17 (native Claude/Codex sessions currently get no memory at all because they bypass the one path that has injection).

### Refinement 2 — Agent Handoff needs its own state, not just memory

The audit found no handoff mechanism exists today (R-18) — continuity is whatever landed in async L0-L3 capture, which per R-17 is sometimes nothing. Session State (already in the skeleton) should therefore explicitly be two layers, not one:

- **Memory-pipeline state** (buffers, extraction-trigger counters — maps to `MemoryCore`'s `IStateBackend`/`LocalStateBackend`).
- **Agent/task session state** (active provider, working directory, open task, conversation-position cursor, in-flight tool calls) — this is the layer Agent Handoff actually reads/writes to produce a handoff package. Nothing in the audited system tracks this today; it's genuinely new.

With those two refinements noted, here is the module-by-module design:

---

## Runtime Core

The process/orchestration layer that starts and supervises everything else. Owns: Docker/container lifecycle (or equivalent), the shared health-check implementation Health/Recovery calls into, and the top-level config loader (env → YAML → defaults precedence, following the pattern already proven in `MemoryCore/src/gateway/config.ts` and `MemoryProxy/src/config.ts` — both audited components already do this precedence chain correctly).

**Reuses:** `TdaiCore` as a library dependency (audit confirms it's host-agnostic by design — see `TENCENT_MIGRATION_MAP.md` § Runtime Core).
**Replaces:** raw `docker run` + bash orchestration (`deploy/global-images/*.sh`) with real compose/orchestration, keeping the `wait_healthy`/`require_vars` *semantics* as design inspiration, not the bash implementation.

## Agent Router

Resolves "given a project + intent, which agent/provider handles this" — generalizes the launcher's registry-driven project resolution (alias map, CWD auto-detect, interactive fallback — all proven patterns) plus a **data-driven** provider table replacing the current 3-way hardcoded PowerShell `switch`.

**Reuses:** `MemoryProxy`'s `upstream.agents[<name>]` config table as the shape for the provider-routing config; `src/agent-adapters/{claude-code,codebuddy,default}.ts` interface pattern for CLI-shape adapters.

## Agent Handoff

**New — no existing precedent.** Produces/consumes a handoff package: agent/task session state (see Refinement 2) + a Context Manager-assembled summary of recent working memory, sized to fit the receiving agent's context budget (via Token Manager). Should not depend solely on async L0-L3 capture completing in time — needs a synchronous "flush current state" primitive independent of the memory pipeline's own timers/debouncing, since `LocalStateBackend`'s in-memory bookkeeping is explicitly not crash-durable (audit finding, `PHASE_1_EXISTING_SYSTEM_AUDIT.md` §2) and handoff needs a stronger guarantee than "eventually captured."

## Context Manager

The consolidation point for the three-way split found in the audit (Refinement 1). Provides one API: given a session + query, return `{ cacheable, dynamic }` content blocks, matching the shape `auto-recall.ts` already produces, but reachable from every provider path — including the ones (native Claude, native Codex per the launcher audit) that currently get nothing.

**Reuses directly:** `MemoryCore/src/core/hooks/auto-recall.ts` logic and its `appendSystemContext`/`prependContext` split; `applyRecallBudget()`'s UTF-8-safe truncation.
**Reuses as pattern:** `MemoryProxy`'s bridge-route trick (`skill-bridge.ts`/`memory-bridge.ts`) of letting the LLM call tool endpoints through a layer that injects real credentials server-side, so secrets never enter the visible prompt.

## Prompt Cache Intelligence

Sits directly on top of Context Manager's stable/dynamic split and adds what's currently missing: emitting **provider-specific cache directives** (Anthropic's explicit `cache_control` breakpoints vs. OpenAI-style automatic prefix caching vs. whatever Gemini/local models need). This is new work, but scoped narrowly — the hard part (separating cacheable from dynamic content) is already solved by the code being reused into Context Manager.

## Token Manager

Context-window budgeting (distinct from MemoryProxy's Redis-based request-rate limiting, which is a separate, also-reusable concern that can sit alongside this rather than inside it).

**Reuses:** `applyRecallBudget()` char/count budget logic from `auto-recall.ts`.

## Tencent Memory

The L0→L3 engine, storage, and memory-pipeline session state — narrowed per Refinement 1 to exclude context-assembly (that's Context Manager's job now).

**Reuses:** `MemoryCore/src/core/*` (pipeline algorithms), `src/core/store/*` + `src/core/storage/*` (SQLite/TCVDB, local-FS/COS abstractions), `src/adapters/standalone/*` as the template for CONTINUUM's own `HostAdapter`. Integration is via the Gateway HTTP server (`src/gateway/server.ts`), not in-process embedding, to stay decoupled from MemoryCore's own release cycle.

## Provider Adapters

| Sub-module | Status | Basis |
|---|---|---|
| Claude | 🔧 refactor | Today's Anthropic-Messages-API-impersonation trick works but is provider-abstraction-shaped wrong (see `TENCENT_MIGRATION_MAP.md`). A native Anthropic `LLMRunner` (🆕, clean extension point already exists in `MemoryCore/src/core/types.ts`) is also needed for memory-processing calls to use Claude directly. |
| DeepSeek | ✅ port pattern | Already "just an OpenAI-compatible upstream with quirks" — proves the adapter pattern; MemoryProxy's `sanitizeThinkingBlocks` handling is the kind of per-provider quirk-patch this layer should keep supporting. |
| Gemini | 🆕 | Nothing exists; needs a router config entry + possibly a new injection/request-shape adapter if Gemini's schema diverges meaningfully from OpenAI/Anthropic shape. |
| Local Models | 🆕 | Nothing exists beyond an unused `node-llama-cpp` peer-dependency allowlist entry. |

## Tool / MCP Layer

**New — zero MCP code found anywhere in the audited system.** Build as an MCP server shim wrapping MemoryCore's Gateway REST API (skill/knowledge/memory endpoints already exist and are well-typed) rather than building a parallel memory system. Preserve the credential-injection-at-the-boundary pattern from MemoryProxy's bridge routes.

## Project Registry

Generalizes `windows/tencent-project-registry.json`: drop Tencent/Claude-specific fields (`settingsFile`, `taskId`), keep `name`/`aliases`/`path`/provider-routing-port concept, add real multi-team/multi-tenant support (today one global team/agent ID pair covers every project — a hard limitation, not a config gap), add file locking (missing today — R-15).

**Reuses as pattern:** alias-map + CWD-auto-detect + interactive-fallback resolution logic; `Add-TencentProject.ps1`'s pre/post-mutation git-fingerprint safety check, generalized into a reusable guard-rail component for any CONTINUUM operation that touches a user's project folder.

## Session State

Split per Refinement 2 into memory-pipeline state (reuse `IStateBackend` pattern) and agent/task session state (new). The latter is what makes Agent Handoff possible and is the component most clearly missing from the audited system today.

## Health / Recovery

Consolidates what's currently three independent, partially-broken implementations (PowerShell `Start-TencentStack`/`Repair-ProjectProxy` with a confirmed dead-code gap — R-12; bash `wait_healthy`; Python watchdog/circuit-breaker) into one shared implementation used everywhere.

**Reuses as pattern:** the Hermes v1 watchdog/circuit-breaker/bounded-thread-pool design — audited and confirmed to exactly match its own documentation, with sensible named constants and in-line rationale for tuning choices (e.g., why the recovery-attempt cooldown is shorter than the circuit-breaker cooldown). This is the best-engineered self-healing code found in the whole audit and is worth porting as a design even into a different implementation language.

## CLI / Launcher

Cross-platform (today: Windows/PowerShell-only), data-driven provider table (today: 3-way hardcoded switch), centralized credential handling (today: plaintext API key duplicated into one YAML file per project), configurable trust/sandbox tiers (today: unconditional permission-bypass flags on every launch, all three providers).

**Reuses as pattern:** registry-driven project + agent selection UX with interactive fallback; env-var sanitization before launch, generalized into a "provider profile declares which vars it owns" abstraction instead of one shared pattern-matched clear-list.

---

## What This Means for Sequencing (see `PHASE_2_RECOMMENDATIONS.md` for the actual scope decision)

The dependency order implied by the design above: **Provider Adapters + native Anthropic LLMRunner** and **Context Manager consolidation** are both prerequisites for **Prompt Cache Intelligence** to mean anything (you can't emit cache directives for content you haven't yet unified). **Session State (agent/task layer)** is a prerequisite for **Agent Handoff**. **Health/Recovery consolidation** and **Project Registry generalization** are largely independent of the others and could be pulled forward opportunistically. **Tool/MCP Layer** depends only on Tencent Memory's existing Gateway API and can proceed in parallel with everything else.
