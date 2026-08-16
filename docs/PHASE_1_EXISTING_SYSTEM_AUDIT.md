# Phase 1 — Existing System Audit: TencentDB Agent Memory

**Audit target:** `C:\Users\<user>\Documents\Ai-tools\TencentDB-Agent-Memory` (fork of the open-source [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) project, local branch `feat/server_team`, canonical remote `TencentCloud/TencentDB-Agent-Memory`)
**Audit method:** read-only static inspection of source, config, and scripts. No containers were stopped/started, no registry data changed, no credentials read or printed. This document distinguishes **verified facts** (cited to file/line) from **recommendations** (marked explicitly).
**Audit date:** 2026-08-14

---

## 1. Component Inventory (verified)

| Component | Path | What it is |
|---|---|---|
| **MemoryCore** | `MemoryCore/` | The memory engine. Hexagonal ("ports and adapters") TypeScript library exposing an HTTP Gateway (`src/gateway/server.ts`) plus an in-process OpenClaw plugin (`index.ts`). Implements the L0→L3 memory pipeline, storage backends (SQLite / TCVDB+COS), session state, and the Hermes Python plugins that supervise it as a subprocess. |
| **MemoryProxy** | `MemoryProxy/` | A transparent, same-protocol forwarding proxy (Hono/Node) that sits between a coding-agent CLI (Claude Code, CodeBuddy) and an upstream LLM endpoint. Injects memory/skill/knowledge context into requests, meters usage, and brokers tool calls back to MemoryCore. **Not** a protocol translator — it forwards Anthropic-shaped or OpenAI-shaped requests in the same shape they arrive in. |
| **MemoryPanel** | `MemoryPanel/` | Admin control plane: team/user/agent/task management API (Node/Hono) + a Vite/React web UI (`web/`). Standalone port 8123. |
| **MemoryKnowledge** | `MemoryKnowledge/` | Wiki (doc ingestion → structured pages) + CodeGraph (repo indexing) service. Standalone port 8421. |
| **`deploy/`** | `deploy/global-images/`, `deploy/panel-knowledge-combined/` | Docker orchestration for the "standard install." Raw `docker run` + bash, **not** docker-compose, for the three core services (memory-core, memory-hub, proxy). `panel-knowledge-combined/` builds MemoryPanel and MemoryKnowledge into **one** container image called `memory-hub`. |
| **`windows/`** | `windows/` | Windows-only PowerShell launcher (`launch-tencent-claude.ps1`), project registry (`tencent-project-registry.json`), registration tool (`Add-TencentProject.ps1`), and test scripts. This is the operator-facing entry point for the user's actual day-to-day usage (6→8 real projects). |
| **`scripts/`** | `scripts/` | Tooling/credential helper scripts (`load-tooling-env.ps1`, `verify-tooling-identity.ps1`, `set-tooling-secret.ps1`) — policy-level identity gates, not code-enforced ones. |
| **`sdk/`** | `sdk/memory-core/{python,typescript}` | Client SDKs; the `python` one (`tdai_memory`) backs the Hermes v2 plugin. |
| **`MemoryKnowledge/docker-compose.yml`** | — | The **only** docker-compose file in the whole repo; a dev-only single-service file for running Knowledge in isolation, not part of the standard install path. |

**Key structural fact:** this is not one monorepo. `MemoryCore/`, `MemoryProxy/`, `MemoryPanel/` each have their own independent `package.json`/`pnpm-workspace.yaml` — four separate Node projects living side by side in one git repo, plus a Python surface (Hermes plugins) and a PowerShell surface (`windows/`).

---

## 2. MemoryCore — Memory Engine (verified)

**Two entrypoints, two hosts:**
- `MemoryCore/index.ts` — OpenClaw plugin entrypoint (in-process, `openclaw.extensions` in `package.json`). Two sub-modes: `"local"` (default, engine runs in-process) or `"client"` (delegates to a remote Gateway).
- `MemoryCore/src/gateway/server.ts` (2,759 lines) — standalone HTTP Gateway (`TdaiGateway`, built on Node's native `http`, no Express). This is what the Hermes v1 Python plugin supervises as a subprocess, and what MemoryProxy's injection pipeline calls over HTTP. Default port `8420` (`TDAI_GATEWAY_PORT` env → YAML → hardcoded default in `src/gateway/config.ts`).

**Architecture:** hexagonal. `TdaiCore` (`src/core/tdai-core.ts`) is the engine and depends only on interfaces in `src/core/types.ts` (`HostAdapter`, `RuntimeContext`, `LLMRunnerFactory`) — never on OpenClaw or Node's `http` directly. Two concrete `HostAdapter`s exist today: `OpenClawHostAdapter` (routes LLM calls through OpenClaw's embedded agent) and `StandaloneHostAdapter` (used by the Gateway; calls any OpenAI-compatible `/chat/completions` endpoint via the Vercel AI SDK — **no native Anthropic Messages API client exists anywhere in MemoryCore**).

**Memory pipeline (L0→L3):**

| Layer | What | Code |
|---|---|---|
| L0 | Raw conversation, JSONL-sharded by date, synchronously persisted to the vector store before the HTTP response returns | `src/core/conversation/l0-recorder.ts` |
| L1 | Atomic facts, extracted + deduped, indexed via SQLite FTS5 (BM25) or vector embedding | `src/core/record/*` |
| L2 | Scenario blocks (Markdown), navigable via a link/scene index | `src/core/scene/*` |
| L3 | Persona / long-term profile | `src/core/persona/*` |

**Context assembly for the model — the single most important file for later prompt-caching work:** `src/core/hooks/auto-recall.ts`, `performAutoRecallCore()`. It splits recall output into two channels by design:
- `appendSystemContext` — L3 persona + L2 scene index + a static tool-usage guide. Changes rarely across turns of the same session → **cacheable**.
- `prependContext` — L1 relevant-memories, changes every turn → deliberately kept **out of** the system prompt so it doesn't bust the cache.

This split exists **only** on the OpenClaw-embedded path. The Hermes **v1** plugin's own `prefetch()` (Python, `hermes-plugin/memory/memory_tencentdb/__init__.py`) calls the Gateway's L1/L2/L3 endpoints directly and flattens all three into one string with no stable/dynamic separation — **the prompt-caching-aware design is not available on every integration path today.** (See Risk R-16 in `RISKS_AND_TECH_DEBT.md`.)

**Storage backend selection:** two independent axes — `deployMode` (`standalone`|`service`) and `storeBackend` (`sqlite`|`tcvdb`), both env-var-first then YAML then default. `sqlite` (default) uses `sqlite-vec` (pinned to an alpha release, `0.1.7-alpha.2`) at `<dataDir>/vectors.db`. `tcvdb` fails fast if Tencent Cloud Vector DB credentials are incomplete — no silent fallback.

**Session state:** `LocalStateBackend` (standalone mode) is a **pure in-memory `Map`-based** implementation — session buffers, pending-extraction counters, and debounce timers all live in process memory with no disk persistence. Raw L0 data is durable (written to the vector store synchronously), but the *bookkeeping* that decides "when has this session accumulated enough turns to trigger L1 extraction" is not — a crash can silently delay or skip L1 extraction for that session. A `RedisStateBackend` exists for service mode (multi-replica coordination), referenced but not deep-audited in this pass.

**Hermes v1 Python plugin** (`hermes-plugin/memory/memory_tencentdb/`) supervises the Gateway as a subprocess with real self-healing:
- Cross-process file lock + in-process thread lock prevent double-spawn.
- Watchdog thread, 10s interval, HTTP `/health` probe on suspected failure.
- Circuit breaker: 5 consecutive failures trips it, 60s cooldown.
- Auto-recovery throttle: 15s cooldown, non-blocking lock so concurrent failures don't pile up trying to resurrect simultaneously.
- Bounded background-thread pool for async capture (`_MAX_INFLIGHT_SYNCS = 4`), with a documented risk that in-flight captures can be abandoned (5s join timeout) on shutdown.
- `v1` plugin's `end_session()` is now a deliberate no-op — v3 architecture moved session-end handling to server-side timer-based scanning.

**MCP:** a repo-wide case-insensitive search for MCP/Model Context Protocol found **zero matches** anywhere under `MemoryCore/`. Tool exposure today is entirely host-native (OpenClaw plugin tools, or Hermes's own bespoke `MemoryProvider` tool-schema ABI) — nothing here is MCP-compliant.

---

## 3. MemoryProxy — Context-Injection Middleware (verified)

**What it actually is:** README.md:5 states explicitly it is "transparent to both the client and the upstream model — it changes no protocol." It is best understood as **memory/context-injection middleware + observability/billing sidecar**, not an Anthropic↔OpenAI translator. Whatever protocol shape a request arrives in (`/v1/messages` Anthropic-style, `/v1/chat/completions` OpenAI-style), it forwards in that same shape to whatever upstream is configured for it.

**Request pipeline** (per-request, both protocol handlers): `auth` → `sessionInit` (first-turn interactive team/agent/task picker, injected as fake conversation turns) → `injection` (splices Skills/Knowledge/Memory L2-L3 into the system prompt or `messages`, via direct HTTP calls to MemoryCore) → `rateLimit` (Redis, per-spaceId × model) → `forward` (plain `fetch()` passthrough, SSE streaming preserved) → `extract` (async write-back of the conversation to MemoryCore) → `report` (ClickHouse/Langfuse/Opik/billing).

**Port model:** every MemoryProxy container listens on `8096` internally, always (`DEFAULT_CONFIG.server.port` in `src/config.ts`, `EXPOSE 8096` in `Dockerfile`). **The proxy has no internal concept of "which project."** The "6-8 projects on 6-8 ports" appearance is achieved entirely by running one full container per project and letting Docker remap the host-side port (`-p 127.0.0.1:<projectPort>:8096`) — a pattern defined in `windows/launch-tencent-claude.ps1` and `deploy/global-images/start-all.sh`, not in MemoryProxy itself. Within one instance, `spaceId` (extracted from the URL path) multiplexes MemoryCore tenant/memory routing — an orthogonal concern to "which upstream LLM."

**MemoryCore integration:** deep and direct — typed HTTP clients for auth (`/v3/meta/auth/verify`), team/agent/task metadata, skill search/archival, and L0-L3 memory (`tdai/client.ts`). Two reverse-proxy "bridge" routes (`/skill-bridge/*`, `/memory-bridge/*`) let the LLM itself call MemoryCore tool endpoints through the proxy, with the proxy injecting the real credential server-side so it never appears in the LLM-visible prompt.

**Health/recovery:** `/health` reports storage-backend degradation (cos→sqlite→fs→memory fallback chain) and 503s if a multi-node deployment has silently degraded to a process-local backend. A Docker `HEALTHCHECK` polls it every 30s. There is **no in-process watchdog or circuit breaker for a crashed proxy** — recovery is entirely external (Docker restart policy, or the Windows launcher's own repair logic, or an unused `scripts/proxy.sh` bash daemon that is not wired into the Docker path at all).

**Claude/DeepSeek coupling assessment:** DeepSeek is not specially coupled anywhere — it's treated as "an OpenAI/Anthropic-compatible upstream with a couple of known quirks" (e.g. `sanitizeThinkingBlocks` strips unsigned `thinking` blocks DeepSeek emits, `anthropicHandler.ts`). The real coupling surface is `src/agent-adapters/` (`claude-code.ts`, `codebuddy.ts`, `default.ts`) — this adapts to the **coding-agent CLI's request shape**, not the model provider, and is already built as a clean `AgentAdapter` interface with a factory and a safe unknown-client fallback.

---

## 4. MemoryPanel + MemoryKnowledge — "memory-hub" (verified, non-obvious finding)

**`memory-hub` is not a single service.** It is a combined Docker image (`agentmemory/memory-hub`, built by `deploy/panel-knowledge-combined/Dockerfile`) that packages **two independently-versioned Node applications** — MemoryPanel and MemoryKnowledge — as **two separate processes inside one container**, supervised by a plain bash script (`start-combined.sh`), not a process manager and not compose-level composition.

- Port 8125 = Panel process (control API + serves the pre-built React UI as static files from the same Hono server).
- Port 8424 = Knowledge process (Wiki + CodeGraph).
- **Ports differ between standalone and combined builds** with no shared source of truth other than reading the Dockerfile: standalone Panel defaults to 8123, standalone Knowledge to 8421; the combined image env-overrides them to 8125/8424.
- Startup ordering inside the container: Knowledge must be healthy before Panel starts, because Panel calls Knowledge's `/v3/internal/llm-binding/status` at boot.
- `LLM_MODE=proxy` (Knowledge's default) creates an implicit **Knowledge → Panel → Proxy → memory-core** dependency chain that `start-all.sh`'s top-level ordering (core → hub → proxy) does not fully account for.

---

## 5. `deploy/` — Docker Orchestration (verified)

No docker-compose for the three core services. `deploy/global-images/start-all.sh` orchestrates via bash + raw `docker run`, in this order: **memory-core → memory-hub (panel+knowledge) → proxy → registry-driven per-project proxies** (reading `windows/tencent-project-registry.json`, skipping the `jarvis` slug as a hardcoded special case since it maps to the core proxy).

Every container start is gated by a hand-rolled `wait_healthy()` poll of `docker inspect`'s health status (falls back to bare "running" if the image defines no `HEALTHCHECK`). `require_vars()` validates all 16 required env vars up front before touching Docker, so partial-failure-halfway-through is avoided for the top-level trio (Step 4's per-project proxies are more resilient still — they check running-state and no-op if already up).

**Bind-scope inconsistency (verified, security-relevant):** memory-core and proxy bind `127.0.0.1:<port>` (loopback-only); memory-hub binds `<port>:<container-port>` with **no loopback prefix**, i.e. all interfaces — meaning the admin Panel UI (8125) and the Knowledge API (8424) are the most network-exposed of the four ports, by default, while carrying default `admin`/`local`-equivalent credentials (documented in `deploy/global-images/README.md` as unsafe beyond single-user local use, but not enforced by any script).

**Documented, currently-broken "secure" path:** if `MEMORY_CORE_GATEWAY_API_KEY` is set non-empty, a source bug in `MemoryProxy/src/auth.ts` omits the Bearer header on `auth.verify` calls and breaks proxy↔core auth entirely — so the scripts default to an empty/`local` key to route around it. **The secure configuration does not currently work.**

---

## 6. `windows/` — Launcher, Project Registry, Runtime Flow (verified)

Full detail in `RUNTIME_FLOW.md`. Summary facts:

- `windows/launch-tencent-claude.ps1` is the single entry point (desktop shortcut → PowerShell). It is **not itself version-controlled as a shortcut** — the `.lnk` file lives outside the repo.
- `windows/tencent-project-registry.json` is the source of truth for **8** registered projects (not 6 — two Android variants were added after the last internal report), each with `name`, `aliases[]`, `path`, `settingsFile`, `taskId`, `proxyPort`, `containerSlug`. A single global `teamId`/`agentId` pair is shared by all projects — no multi-team/multi-tenant concept exists at this layer.
- Three agent targets are supported: **DeepSeek** (routed through the local per-project proxy, impersonating the Anthropic Messages API so an unmodified Claude Code binary can be pointed at it via `ANTHROPIC_BASE_URL`), **native Claude** (isolated `.claude-anthropic` config dir, all Tencent/proxy env vars explicitly cleared), and **native Codex** (fully outside the Tencent memory/task-tracking loop — no env-var integration at all).
- Environment sanitization runs before every launch: a large pattern-list of inherited env vars is cleared to prevent leakage between a prior tool session (evidence this launcher was built to coexist with, and defend against, a separate "Jarvis" agent system in the same shell environment).
- **All three agent launch paths use permission/sandbox-bypass flags unconditionally** (`--permission-mode bypassPermissions` for Claude, `--dangerously-bypass-approvals-and-sandbox` for Codex) — there is no safer default mode offered by this launcher.
- `windows\Add-TencentProject.ps1` performs project onboarding with a genuinely good safety pattern: it fingerprints the target project folder (git remote/HEAD/file-counts) before and after registration and rolls back all Tencent-side bookkeeping if the fingerprint changed unexpectedly mid-registration — but it never touches the project's own source.
- `scripts\verify-tooling-identity.ps1` is described in `CLAUDE.md` as a "hard gate before any production mutation," but **no script in the codebase actually invokes it** — it is a policy convention enforced through agent instructions, not a code-level gate.

---

## 7. Runtime Dependencies & Ports (consolidated, verified)

| Port | Owner | Scope | Notes |
|---|---|---|---|
| 8420 | MemoryCore Gateway | loopback (deploy) / container-network (proxy↔core) | Auth (Bearer) gate, off by default |
| 8096 | MemoryProxy | loopback per instance; one container per project | Same internal port on every instance; host port varies per project |
| 8097–8103 | Per-project MemoryProxy instances | loopback | 8096 host-remapped per `tencent-project-registry.json` |
| 8123 / 8125 | MemoryPanel | loopback (standalone) / **all interfaces** (combined `memory-hub`) | Port literal changes between build modes |
| 8421 / 8424 | MemoryKnowledge | loopback (standalone) / **all interfaces** (combined `memory-hub`) | Port literal changes between build modes |
| 6379 | Redis | service-mode only | distributed lock + task queue |
| — | TCVDB, COS | service-mode only | Tencent Cloud vector DB + object storage |

**Runtime/toolchain:** Node ≥22.16 (ESM, TypeScript ^6.0.2, `tsdown` build), Python (Hermes plugins, stdlib `urllib` only), PowerShell 5.1-class Windows scripting, Docker (raw CLI, no compose for core services), `pnpm` per sub-project.

---

## 8. What Is Tightly Coupled to Claude Code / DeepSeek (verified)

| Coupling | Where | Nature |
|---|---|---|
| Anthropic-Messages-API impersonation for DeepSeek | `windows/launch-tencent-claude.ps1` env vars (`ANTHROPIC_BASE_URL` etc.) + MemoryProxy's Anthropic handler | Architectural trick, not incidental — the whole DeepSeek routing model depends on Claude Code's CLI accepting a redirected `ANTHROPIC_BASE_URL` |
| `--settings <path>` JSON schema, `CLAUDE_CONFIG_DIR` | Windows launcher, `Add-TencentProject.ps1` | Claude Code CLI-specific config mechanism |
| `src/agent-adapters/{claude-code,codebuddy,default}.ts` | MemoryProxy | Coupled to CLI request *shape*, not to the model provider — already interface-isolated |
| `src/session/claude-code/*` vs `codebuddy/*` | MemoryProxy | CLI-specific fake-turn rendering for the session-init form |
| `src/injection/adapters/{anthropic,openai}.ts` | MemoryProxy | Genuine protocol-level coupling (where the system prompt lives) — small, isolated, would need one more adapter for a genuinely different schema (e.g. Gemini) |
| OpenAI-compatible-only LLM calls | MemoryCore `StandaloneLLMRunner` (Vercel AI SDK, `compatibility: "compatible"`) | No native Anthropic client anywhere in MemoryCore — Claude can only be reached through an OpenAI-compatibility shim today |
| `x-team-id`/`x-agent-id`/`x-task-id` custom headers | Windows launcher, deepseek path only | Bespoke to this Tencent proxy; native Claude/Codex sessions have **no** project/task binding beyond CWD |

---

## 9. Directly Reusable Components (verified assessment, detail in `TENCENT_MIGRATION_MAP.md`)

- MemoryCore's `src/core/*` (engine, L0-L3 algorithms, `HostAdapter`/`RuntimeContext`/`LLMRunner` interfaces) — host-agnostic by explicit design.
- MemoryCore's Gateway HTTP server as an integration surface (host-neutral REST API).
- MemoryCore's `auto-recall.ts` stable/dynamic context-assembly split — the seam CONTINUUM's prompt-cache layer wants.
- MemoryProxy's forwarding engine, config system, `ProxyStorage`, rate-limiting, observability, and MemoryCore-integration clients (~70% of the codebase, provider-agnostic).
- MemoryProxy's `upstream.agents[]` per-agent routing table and `AgentAdapter` interface — clean templates for a multi-provider registry.
- Hermes v1's subprocess-supervision mechanics (health-checked spawn, process-group kill, watchdog, circuit breaker, bounded background-thread pool) — generic engineering, reusable independent of Hermes.
- The registry-driven "one process per project" deployment pattern, and the project-safety fingerprint pattern in `Add-TencentProject.ps1`.

## 10. Needs Refactoring / Should Not Be Carried Forward As-Is

- Raw `docker run` + bash health-polling orchestration (replace with real compose/orchestration; keep the *health-check semantics* as inspiration).
- The 3-agent hardcoded env-var switch statement in the Windows launcher (must become data-driven).
- `memory-hub`'s two-services-in-one-container bundling with divergent ports between build modes.
- Default/well-known credentials, inconsistent bind-scoping, per-project plaintext key duplication, the currently-broken "secure" auth path.
- Unconditional permission/sandbox-bypass launch flags.
- Two divergent, non-shared memory-context-assembly implementations (OpenClaw-embedded vs. Hermes v1 HTTP) with inconsistent capability.
- Windows-only, PowerShell-only launcher with 4×-duplicated special-case logic (`jarvis` slug, container-slug derivation regex) and no shared library module.

Full risk detail with severity and file citations: see `RISKS_AND_TECH_DEBT.md`.
