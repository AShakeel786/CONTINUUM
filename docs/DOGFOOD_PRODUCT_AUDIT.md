# CONTINUUM — Full Product Dogfood Audit

**Date:** 2026-08-16
**Auditor:** agent (read-only; no code/config modified, nothing pushed)
**Method:** hands-on use of the installed daily workflow (`~/Applications/CONTINUUM.app`, `~/.local/bin/continuum`, real `~/.continuum` config, real Codex + DeepSeek/Tencent stack), plus source read-through of `~/Developer/Ai-tools/CONTINUUM` and reference-stack comparison.

---

## 0. Reference-stack path resolution (as instructed)

`~/Developer/Ai-tools/gstack` **does not exist** and no `gstack` source checkout/archive exists anywhere under `~/Developer/Ai-tools` or `~/Documents/Ai-tools`. What actually exists:

- **Per-project runtime scratch dirs** named `.gstack/` in many project checkouts (CARS, AVOP, qubaelementary, HVAC, Jarvis, AlBaikPizzaOrdering) — these are *runtime state*, not source. They contain: `browse-audit.jsonl`, `browse-network.log`, `browse-console.log`, `claude-available.json`, `tabs.json`, `active-tab.json`, `terminal-agent-pid`, `terminal-internal-token`, `terminal-port`, `qa-reports/`.
- **GSTACK audit documents** (e.g. `AVOP_GSTACK_PRODUCTION_AUDIT.md`, `CARS_PHASE25_GSTACK_CONTENT_INTEGRITY_AUDIT.md`) — these are app audits produced *with* a "gstack" browser+terminal agent harness, not a product of their own.

The closest thing to a "reference stack" for workflow/UX/agent-stack ideas is the user's own prior **Windows "Development Agent Launcher"**:

- `~/Developer/Ai-tools/tencent-windows-tooling/` (`launch-tencent-claude.ps1`, `install.ps1`)
- `~/Developer/Ai-tools/TencentDB-Agent-Memory/UNIFIED_AGENT_LAUNCHER_REPORT.md`

So the gstack comparison below is against (a) the `.gstack` harness's observable behavior and (b) the Windows launcher/TencentDB stack. CONTINUUM is, in effect, the *productized* version of that same prior workflow.

---

## 1. Desktop / startup UX

| Check | Result |
|---|---|
| Icon | ✅ `continuum.icns` (1.8 MB) present and referenced by `CFBundleIconFile`; full icon set in `assets/icons`. |
| App bundle | `LSUIElement=true` (agent app, no Dock tile). Launcher is a bash script that `osascript`-opens **Terminal.app**, exports an explicit `PATH`, runs bare `continuum`, then returns to the user's login shell. |
| Startup speed | ✅ `continuum --version` ≈ **0.09 s**; `continuum doctor` ≈ **1.3 s**. |
| Terminal behavior | ✅ explicit PATH export solves the "desktop-launched apps get a minimal PATH" problem; no forced `bash`, returns to normal prompt. |
| First-menu clarity | ✅ numbered menus, `0. Exit`, live "Register current directory" option, usable-provider filtering. |

**Fresh-user asks:** "What do I do next?" → the bare `continuum` menu answers this well (Choose project → action → agent). Good.

**Friction / gaps:**
- Hardcoded `Terminal.app` (ignores iTerm2 preference); `LSUIElement` is slightly odd for an app whose only job is to open a Terminal window (harmless, but surprising).
- With no registered project, the menu only offers "+ Add project" and "Manage projects" — reasonable, but the very first thing a brand-new user must understand is *what a provider is*; that concept is not explained in the menu itself.

---

## 2. Project workflow

| Check | Result |
|---|---|
| add/manage/remove | ✅ `project add/remove/list/show` + interactive menu (`+ Add project`, `Manage projects`, register current dir). |
| register current directory | ⚠️ **Interactive-only.** `project add` requires explicit `<name> <path>`; there is no `.` shorthand and no `project register` CLI equivalent. |
| default provider | ⚠️ Only set at add-time; `Manage projects` menu cannot change it. `project show` does not display `defaultModel`. |
| infrastructure vs work-project | ❌ No project "kind"/tag. All projects are uniform; the Tencent memory/agent infra isn't modeled as a project (fine), but there's no way to mark a project as "work" vs "scratch". |

**Evidence of the default-provider gap:** `projects.json` has `continuum [default: codex]`, but `passcars` and `NisfDeen` have **no** `defaultProvider`. A fresh user who adds a project without `--provider` then runs `launch <project>` has no idea which agent will be chosen (and `launch` resolution will differ from the interactive menu's explicit "choose agent" flow — inconsistent).

**Fresh-user asks:** "How do I set the default agent for a project after creating it?" → answer is buried (must `project add` again with `--provider`, or edit JSON). No in-menu path.

---

## 3. Provider workflow

| Check | Result |
|---|---|
| Codex | ✅ `codex` CLI installed (`0.147.x`), sessions run with it. |
| DeepSeek proxy | ✅ configured (`credential://deepseek/api-key`, `method: api`), doctor reports `ok`. |
| native Claude unavailable state | ✅ handled cleanly: `claude: not configured (claude CLI detected — run "continuum auth claude")`. |
| arbitrary API/CLI providers | ✅ `provider add` with secret-free JSON manifests (OpenAI/Anthropic-compatible + CLI). |
| auth/setup clarity | ✅ `setup` wizard, masked prompts, OS keychain, `credential://` refs only. |

**Friction / gaps:**
- **Contradictory panel.** `continuum providers` says `codex: not configured (codex CLI detected — run "continuum auth codex")`, yet `projects.json` has `continuum [default: codex]` and multiple `[codex]` sessions exist. "not configured" really means "the native codex CLI is present but CONTINUUM hasn't run its own auth handshake" — the wording actively misleads a user who *has* been running Codex sessions.
- `providers` vs `provider list` are two different surfaces (auth-state vs manifest registry) with similar names — easy to confuse.

---

## 4. Session workflow

| Check | Result |
|---|---|
| new/resume/recent | ✅ `launch`, `resume <id>`, `resume --recent N`, `sessions`. |
| Codex ↔ DeepSeek handoff | ✅ `handoff <session>` — never auto-selects, lists authenticated candidates, sets active provider. |
| continuity quality | ❌ **See P0-2.** Work/decision/file/tool-activity state is never populated in practice. |
| unnecessary re-auditing | ⚠️ `resume-block.ts` correctly instructs "Do not re-audit", but because the session carries no work summary, the receiving agent has nothing concrete to skip re-auditing *with*. |
| stale/dead sessions | ❌ All sessions are `active`; no archive/complete flow; smoke-test and `(no explicit goal supplied)` sessions clutter the list; no cleanup. |

**Evidence:** real session JSON shows `completedWork: []`, `remainingWork: []`, `importantDecisions: []`, `relevantFiles: []`, `recentToolActivity: []` for every session, including the "daily workflow check" session.

**Fresh-user asks:** "How do I finish/close a session?" → there is no command for it (`sessions` only lists/archives via a flag that isn't surfaced in `--help`). "Which of these 5 `active` sessions is my real work?" → not answerable from the list.

---

## 5. Memory / context

| Check | Result |
|---|---|
| MemoryCore recall quality | ⚠️ **Inert in daily use.** The gateway integration is complete (L3 persona → `persona` block, L2 scene index → `scene-index` block, L1 → `recalled-memory` blocks, provenance-tagged, priority-ordered). But the launch path gates it behind env vars that are not set (see P0-1). |
| noise/relevance | ✅ architecture is sound: `persona`/`scene-index`/`recalled-memory` are allowlisted to come *only* from MemoryCore; recalled memories are priority 80 (dropped first). |
| MCP | ✅ `continuum-mcp` + `mcp-setup` registered with both Claude and Codex (doctor confirms). Memory tools (`memory_recall/search/capture/store_atom`) + session tools (`session_state/recent`, `project_state/list`) well-defined. |
| repo map | ✅ 4 `.map` files cached; built with a token budget, navigation-only. |
| handoff context | ⚠️ `flushHandoff` produces objective + git summary + a correct `resume-instructions` block, but the work/decision/file/tool lists are empty (starved of data). |
| context-envelope quality | ✅ single assembly path, class-allowlist enforcement, reversible pruning to budget. Strong. |

**Fresh-user asks:** "Is my memory working?" → doctor says healthy, but launch says "MemoryCore not configured". Directly contradictory, and no command explains how to wire it.

---

## 6. Token efficiency (observed)

| Feature | State in daily use |
|---|---|
| Tool Output Optimizer | ✅ active — 16 raw outputs retained out-of-band in `~/.continuum/tool-output/`; deterministic, LLM-free, `tool-output://<id>` refs. |
| Repo Map | ✅ active — 4 cached maps. |
| Tool Result Cache | ⚠️ **API-agent path only.** For native CLI providers (claude/codex/deepseek-as-claude), CONTINUUM spawns the native binary and does **not** intercept tool calls, so the tool cache and tool-output optimizer do not apply to the agent's own tools. |
| Reversible Pruning | ⚠️ built, but `~/.continuum/pruned-context/` is **empty** — has never actually pruned a real envelope (contexts have been too small to trigger it). |

**Note:** the measured `6,167 → 4,734` (−23.2%) benchmark is from the **API-agent** runtime. For the two providers this user actually uses daily (Codex native, DeepSeek-as-Claude), most of the token-efficiency machinery is *not on the execution path* — only the launch-context assembly (repo map + memory + pruning) applies.

---

## 7. Health / recovery

| Check | Result |
|---|---|
| MemoryCore stopped | ✅ doctor reports it as a failed/degraded check; launch preflight surfaces warnings but **never blocks** launch (degraded mode is a feature). |
| proxy stopped | ✅ same — `proxy:auth` check degrades; launch continues. |
| doctor --repair | ✅ verified hands-on on a healthy stack: correctly reports "nothing to repair"; repair strategies (docker start/restart/recreate, stale-process reap, provider/credential directives) are bounded by cooldown + circuit breaker and a pinned-image guard that refuses to fall back to `latest`. Excellent. |
| degraded mode | ✅ launch preflight is failure-tolerant; pricing/handoff checks are advisory and never block. |
| misleading auth failures | ⚠️ "MemoryCore not configured" (launch) vs "running/healthy" (doctor) is the main misleading message. Also "codex: not configured" vs existing codex sessions. |
| recovery messaging | ✅ `doctor --repair` output is clear and actionable (directives point at `continuum auth <id>` / `continuum setup`). |

---

## 8. gstack / reference-stack comparison

Reference = Windows "Development Agent Launcher" (`launch-tencent-claude.ps1` + TencentDB registry) and the `.gstack` browser+terminal harness. Classification:

| Reference idea | Classification | Note |
|---|---|---|
| Project registry (per-project name/path/aliases) | **ALREADY_HAVE** | CONTINUUM `projects.json` is cleaner — no per-project port/proxy allocation needed (Docker routes it). |
| Project → agent menu (unified launcher) | **ALREADY_HAVE** | CONTINUUM's interactive front door is richer (adds resume/handoff). |
| Agent aliases (`ds`/`claude`/`codex`) | **PARTIAL → ALREADY_HAVE** | CONTINUUM has `--provider <id>` + project aliases, but no provider *aliases* (`ds` doesn't map). Minor. |
| Per-agent env isolation (`.claude-anthropic` vs `.claude-tencent`, `ANTHROPIC_*` sanitized) | **ALREADY_HAVE** | CONTINUUM does this data-driven via provider profiles + `clearEnvVars`. Equal or cleaner. |
| `claude-available.json` auto-discovery | **ALREADY_HAVE (BETTER)** | CONTINUUM integrates it into `providers`/`doctor` with an actionable directive. No separate json file. |
| MCP memory bridge ("memory via MCP, inference stays native") | **ALREADY_HAVE (AHEAD)** | The Windows report *recommended* this; CONTINUUM already built `continuum-mcp` + memory tools. |
| `browse-audit.jsonl` — append-only structured activity log (what the agent did, continuously) | **MISSING_HIGH_VALUE** | The *concept* maps directly onto CONTINUUM's empty `recentToolActivity`/`completedWork`. CONTINUUM has the field but no writer. |
| Browser automation (screenshots/network/console/tabs) | **NOT_SUITABLE** | Different domain (web-app QA vs coding-agent orchestration). |
| Internal terminal-agent (pid/token/port) | **NOT_SUITABLE** | CONTINUUM spawns CLIs directly; no internal HTTP agent needed. |
| Per-task proxy port allocation (8096/8097/8099/…) | **NOT_SUITABLE** | CONTINUUM uses session ids + one Docker proxy. |

**Verdict:** CONTINUUM is the productized, cleaner version of the same workflow. The only genuinely useful idea *not* already present is the **continuous append-only activity log** — which is precisely the missing session write-back (P0-2). gstack is **not** materially smoother; CONTINUUM wins on env isolation, health/recovery, and the MCP memory bridge.

---

## 9. Fresh-user perspective (step-by-step "would I know what to do next?")

1. **First launch** → bare `continuum` menu. ✅ Clear enough. (But "provider" concept unexplained.)
2. **`continuum project add`** → needs `--help`… which returns "Unknown subcommand `--help`". ❌ Discoverability breaks immediately for CLI-first users.
3. **`continuum launch --help`** → actually *launches* (creates a session + spawns Codex) instead of showing usage. ❌ Side-effect from a `--help` flag.
4. **`continuum doctor`** → healthy, "MemoryCore running". ✅ Then `continuum launch` says "MemoryCore **not configured**". ❌ Contradiction with no resolution path.
5. **5 `active` sessions, 3 are smoke tests, one "(no explicit goal supplied)"** → ❌ "Which is mine? How do I close one?"

---

## 10. Findings (prioritized)

### P0 blockers

**P0-1 — MemoryCore integration is disabled in daily use (env-var wiring gap).**
- *Reproduction:* `env | grep -i continuum` → only `PWD`/`OLDPWD`. `continuum launch` prints `ℹ️ MemoryCore not configured — launched with local session context only (no Tencent memory).` while `continuum doctor` reports `container:tdai-memory-core: running` and `gateway:memory-core: reachable (HTTP 200)`.
- *Root cause:* `src/cli/commands/launcher-context.ts::memoryCoreFromEnv()` requires **both** `CONTINUUM_MEMORY_CORE_URL` **and** `CONTINUUM_MEMORY_CORE_TOKEN` to be set, with **no default and no discovery**. Meanwhile `src/health/adapters.ts` uses `CONTINUUM_MEMORY_CORE_URL ?? "http://127.0.0.1:8420"` — so doctor sees the stack but launch does not.
- *Why it matters:* The flagship "persistent shared memory" value prop is inert. Every launch, and every MCP `memory_recall/search/capture/store`, degrades to "not configured" for a user whose MemoryCore is actually healthy.
- *Recommended fix:* Give the launch path the same `http://127.0.0.1:8420` default as doctor; add a `setup`/`doctor` step that writes the token (or a `memory` subcommand that discovers the gateway and prompts for the service token); surface the exact "set CONTINUUM_MEMORY_CORE_URL/TOKEN" instruction in the launch note.
- *Effort:* small–medium. *Architecture change:* no (single default + a wiring step).
- *gstack pattern:* `claude-available.json` auto-discovery — same spirit: **discover, don't require manual env**.

**P0-2 — Session continuity is structurally complete but functionally inert (no write-back).**
- *Reproduction:* every real session has empty `completedWork/remainingWork/importantDecisions/relevantFiles/recentToolActivity`. `grep` for `addCompletedWork|recordDecision|recordToolActivity|...` shows **zero non-test callers**. The MCP session surface (`session_state`, `session_recent`, `project_state`, `project_list`) is **read-only**. The API-agent loop (`src/api-agent/run.ts`) never writes session state.
- *Root cause:* `SessionManager` has a full write API, but nothing in the runtime calls it. There is no MCP write tool for sessions; the only write tools (`memory_capture`, `memory_store_atom`) target MemoryCore, not the local `TaskSession`.
- *Why it matters:* `handoff`/`resume` carry only objective + git status + "(nothing recorded yet)". The receiving agent effectively re-audits — the exact thing CONTINUUM exists to prevent. The anti-re-audit `resume-instructions` block is correct but starved of data.
- *Recommended fix:* Add MCP write tools (e.g. `session_update` / `session_record_work` / `session_record_decision` / `session_record_file`) wired to `SessionManager`, and have the API-agent loop auto-append `recentToolActivity` on each tool call. For native CLI providers, accept that the agent must call the MCP write tools (document + prompt it).
- *Effort:* medium. *Architecture change:* yes (a write surface must be added to MCP and invoked).
- *gstack pattern:* `browse-audit.jsonl` append-only activity log → the exact model for `recentToolActivity`.

### P1 majors

**P1-1 — Subcommand `--help` is broken/inconsistent.**
- `continuum launch --help` **launches** (created session `0bb6fd28…` and spawned Codex); `continuum sessions --help` lists sessions; `continuum project --help` → `Unknown subcommand "--help"`. Only top-level `--help` works.
- *Why:* dispatcher passes `rest` straight to each command; none handle `-h/--help`; `launch` treats `--help` as a non-flag (skipped by `args.find(!startsWith("-"))`) and proceeds.
- *Fix:* central `-h/--help` handling per subcommand. *Effort:* small. *Arch:* no.

**P1-2 — Default-provider and project "kind" clarity.**
- New projects often lack `defaultProvider`; `Manage projects` can't set it; `project show` omits `defaultModel`; no project kind/tag.
- *Fix:* `project set-default <proj> <provider>`, show model, optional `--kind`. *Effort:* small. *Arch:* no.

**P1-3 — Provider panel misleads (`codex: not configured` vs active codex sessions).**
- *Fix:* split "CLI detected" from "CONTINUUM auth handshake done"; show a third state ("CLI detected — CONTINUUM auth not yet run, but native CLI usable"). *Effort:* small.

**P1-4 — Session lifecycle: no complete/archive/cleanup.**
- All sessions `active`; smoke-test clutter; no "finish" command; no cleanup.
- *Fix:* `session close`/`archive`, auto-archive on handoff completion, prune `(no explicit goal supplied)` + `smoke test` noise. *Effort:* small–medium.

### P2 usability

- **P2-1** `(no explicit goal supplied)` placeholder — prompt or label clearly; treat empty goal specially in the list.
- **P2-2** "Register current directory" not available from `project` CLI (only interactive). Add `.` shorthand.
- **P2-3** `doctor --repair` output is verbose/duplicative (full diagnose → MCP repair → nothing-to-repair → full re-diagnose). Trim for the common case.
- **P2-4** "MemoryCore not configured" wording should point at the exact env vars / a `setup` action.

### P3 polish

- **P3-1** App launcher hardcodes `Terminal.app`; consider honoring iTerm2/preferred terminal.
- **P3-2** `continuum` (bare) on a non-tty prints `Error: stdin is not a terminal` — friendlier message.
- **P3-3** `providers` vs `provider list` naming collision is confusing for new users.

---

## 11. Strengths (verified)

1. **`doctor` + `--repair` are best-in-class.** Read-only health with bounded, guarded recovery (pinned-image guard, cooldown, circuit breaker, no broad recreation). Verified healthy→"nothing to repair".
2. **Clean, single context-assembly path.** `buildContextEnvelope` with provenance-tagged blocks, class allowlists (MemoryCore-reserved classes can't be smuggled by callers), priority ordering, reversible pruning.
3. **Security posture.** OS-native keychains, `credential://` references only, no secrets on stdout, `no-secrets` tests, documented argv caveat.
4. **Fast startup** (0.09 s version, 1.3 s doctor).
5. **Honest product framing** — beta limitations, third-party provenance, "not a universal savings guarantee".
6. **Deterministic, LLM-free token-efficiency primitives** (output optimizer w/ raw retention, scope-fingerprinted tool cache).

---

## 12. Final report

### Top 10 improvements (ordered)
1. Wire MemoryCore into launch (default URL + token setup) — P0-1
2. Add session write-back (MCP write tools + API-agent auto-log) — P0-2
3. Fix subcommand `--help` — P1-1
4. Default-provider management + project kinds — P1-2
5. Provider panel truthfulness (three-state auth) — P1-3
6. Session lifecycle (close/archive/cleanup) — P1-4
7. `(no explicit goal supplied)` handling — P2-1
8. `project` CLI register-current-directory shorthand — P2-2
9. Trim `doctor --repair` output — P2-3
10. Better non-tty / hardcoded-Terminal polish — P3-1/P3-2

### Top 5 strengths
1. `doctor`/`--repair` recovery engineering
2. Single context-assembly path + provenance/allowlist model
3. Security (OS keychain, no secrets)
4. Fast startup
5. Provider-neutral handoff that never auto-selects

### Biggest daily-use friction
The two "built but not wired" gaps: memory is inert (env vars unset) and session continuity is empty (no write-back). The product *reads* as if it does the two things it advertises, but neither is on the real daily path.

### Best ideas found in gstack
Only one materially-new idea: the **continuous append-only activity log** (`browse-audit.jsonl`) → maps directly onto `recentToolActivity` write-back. Everything else (project registry, agent menu, env isolation, availability discovery, MCP memory bridge) CONTINUUM already has — usually cleaner.

### Highest-value quick wins
1. Default `CONTINUUM_MEMORY_CORE_URL` to `http://127.0.0.1:8420` (matches doctor) — tiny, unblocks memory reads immediately.
2. Central subcommand `--help` handling — tiny, fixes discoverability + the `launch --help` side-effect.
3. Provider three-state wording — tiny, removes a daily confusion.
4. `project set-default` + `.` shorthand — small, fixes default-provider confusion.

### Deeper architecture issues
1. **Write-back is missing** — the session model is write-capable but nothing writes; needs an MCP write surface + agent-loop instrumentation.
2. **Memory/launch config is env-var-gated with no discovery**, while doctor already knows the gateway — a config-resolution split that should be unified.
3. **Token-efficiency applies mainly to the API-agent path**, not the native CLI providers used daily — worth measuring/verifying actual savings on the real (native CLI) path.

### Recommended implementation order
1. P0-1 (memory wiring default + token setup) — unblocks the biggest feature.
2. P1-1 (`--help`) — unblocks safe exploration.
3. P0-2 (session write-back) — makes handoff/resume real.
4. P1-3 + P1-2 (provider truthfulness + default provider) — day-to-day clarity.
5. P1-4 + P2-1 (session lifecycle + goal handling) — kill the noise.
6. P2/P3 polish.
