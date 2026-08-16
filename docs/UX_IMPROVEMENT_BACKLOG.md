# CONTINUUM — UX Improvement Backlog

**Date:** 2026-08-16
**Source:** Full product dogfood audit (`docs/DOGFOOD_PRODUCT_AUDIT.md`). Read-only audit; nothing implemented here.

Priority legend: **P0** blocker · **P1** major · **P2** usability · **P3** polish.
Each item: reproduction → why it matters → recommended fix → effort → architecture change → reference-stack pattern.

---

## P0

### P0-1 — Wire MemoryCore into the launch path (it's running but "not configured")
- **Repro:** `continuum launch` → `ℹ️ MemoryCore not configured — launched with local session context only`; `continuum doctor` → `container:tdai-memory-core: running`, `gateway:memory-core: reachable (HTTP 200)`. `env | grep -i continuum` shows no `CONTINUUM_MEMORY_CORE_URL/TOKEN`.
- **Why:** The persistent-memory value prop is inert. Every launch and every MCP memory tool degrades.
- **Fix:** (1) default `memoryCoreFromEnv()` to `http://127.0.0.1:8420` (same as doctor's `adapters.ts`); (2) add a `setup`/`doctor` step that discovers the gateway and records the service token; (3) make the launch note actionable ("run `continuum setup --memory`").
- **Effort:** small–medium. **Arch change:** no.
- **gstack pattern:** `claude-available.json` auto-discovery (discover, don't require manual env).

### P0-2 — Session write-back (continuity is built but nothing writes to it)
- **Repro:** all real sessions have empty `completedWork/remainingWork/importantDecisions/relevantFiles/recentToolActivity`. Zero non-test callers of `SessionManager` write methods. MCP session tools are read-only.
- **Why:** `handoff`/`resume` carry only objective + git + "(nothing recorded yet)". The receiving agent re-audits — the exact thing the product exists to prevent.
- **Fix:** (1) add MCP write tools (`session_update` / `session_record_work` / `session_record_decision` / `session_record_file`) over `SessionManager`; (2) API-agent loop auto-appends `recentToolActivity` per tool call; (3) prompt native-CLI agents to use the write tools.
- **Effort:** medium. **Arch change:** yes (new MCP write surface + agent-loop instrumentation).
- **gstack pattern:** `browse-audit.jsonl` append-only activity log.

---

## P1

### P1-1 — Subcommand `--help` is broken / has side effects
- **Repro:** `continuum launch --help` **launches** (created session `0bb6fd28…`, spawned Codex); `sessions --help` lists; `project --help` → `Unknown subcommand "--help"`.
- **Why:** Discoverability breaks immediately for CLI-first users; a `--help` flag causing a real launch + session pollution is surprising and potentially harmful.
- **Fix:** Central `-h/--help` handling in `run*Command` (or dispatcher pre-scan).
- **Effort:** small. **Arch change:** no.

### P1-2 — Default-provider management + project "kind"
- **Repro:** `passcars`/`NisfDeen` have no `defaultProvider`; `Manage projects` menu can't set one; `project show` omits `defaultModel`.
- **Why:** `launch <proj>` resolution differs from the interactive "choose agent" flow; users can't fix a project's default after creation.
- **Fix:** `project set-default <proj> <provider> [--model]`, show model in `project show`, optional `--kind` tag.
- **Effort:** small. **Arch change:** no.

### P1-3 — Provider panel truthfulness
- **Repro:** `continuum providers` → `codex: not configured`, yet codex sessions exist and `continuum` default project uses codex.
- **Why:** "not configured" misleads a user who has been running Codex; conflates "native CLI present" with "CONTINUUM auth handshake done".
- **Fix:** Three states: `authenticated` / `CLI detected (native login usable; run "continuum auth <id>" to finish CONTINUUM wiring)` / `not installed`.
- **Effort:** small. **Arch change:** no.

### P1-4 — Session lifecycle (close/archive/cleanup)
- **Repro:** 5 sessions all `active`; "smoke test" / "daily workflow check" / "(no explicit goal supplied)" clutter.
- **Why:** No way to finish a session; list becomes noise; no cleanup.
- **Fix:** `session close|archive`, auto-archive on handoff completion, and filter/group noise sessions.
- **Effort:** small–medium. **Arch change:** no.

---

## P2

### P2-1 — "(no explicit goal supplied)" handling
- **Repro:** empty `taskGoal` in interactive menu → placeholder string in session list.
- **Why:** noise + looks broken.
- **Fix:** prompt for a non-empty goal or render empty goal as `(untitled — started <time>)`.
- **Effort:** small. **Arch:** no.

### P2-2 — `project` CLI register-current-directory shorthand
- **Repro:** "Register current directory" exists in the interactive menu but `project add` requires explicit `<name> <path>`.
- **Fix:** support `continuum project add .` (basename default, cwd path).
- **Effort:** small. **Arch:** no.

### P2-3 — Trim `doctor --repair` output
- **Repro:** full diagnose → "MCP repair" → "nothing to repair" → full re-diagnose on a healthy stack.
- **Fix:** collapse the common "nothing to repair" case into a single line; keep the verbose path only when something actually changed.
- **Effort:** small. **Arch:** no.

### P2-4 — Actionable "MemoryCore not configured" message
- **Repro:** launch note names the symptom but not the fix.
- **Fix:** print the exact env vars or the `setup` command to run.
- **Effort:** trivial. **Arch:** no.

---

## P3

### P3-1 — Launcher terminal preference
- **Repro:** `CONTINUUM.app` hardcodes `Terminal.app`; ignores iTerm2.
- **Fix:** prefer the user's default terminal or detect iTerm2.
- **Effort:** small. **Arch:** no.

### P3-2 — Friendlier non-tty message
- **Repro:** bare `continuum` (or `launch`) on non-tty prints `Error: stdin is not a terminal`.
- **Fix:** "interactive menu requires a terminal — run `continuum <command>` directly."
- **Effort:** trivial. **Arch:** no.

### P3-3 — `providers` vs `provider list` naming
- **Repro:** two similarly-named surfaces (auth-state vs manifest registry).
- **Fix:** rename to `providers` (auth) and `provider-manifest` / `provider list` (registry), or add clearer `--help` descriptions.
- **Effort:** small. **Arch:** no.

---

## Quick-reference: effort × architecture

| ID | Priority | Effort | Arch change | gstack pattern |
|---|---|---|---|---|
| P0-1 | P0 | small–medium | no | auto-discovery |
| P0-2 | P0 | medium | **yes** | append-only activity log |
| P1-1 | P1 | small | no | — |
| P1-2 | P1 | small | no | — |
| P1-3 | P1 | small | no | — |
| P1-4 | P1 | small–medium | no | — |
| P2-1 | P2 | small | no | — |
| P2-2 | P2 | small | no | — |
| P2-3 | P2 | small | no | — |
| P2-4 | P2 | trivial | no | — |
| P3-1..3 | P3 | trivial–small | no | — |

**Suggested order:** P0-1 → P1-1 → P0-2 → P1-3 → P1-2 → P1-4 → P2 → P3.
