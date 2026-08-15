# Phase 2.1 — Baseline Closure Report

**Scope:** close the remaining Phase 2 baseline gaps before Phase 3 (Provider Adapters): commit Phase 2's uncommitted work cleanly, fix the `python3` registry-sync failure, complete the R-8 upstream-key migration on the 8 live proxy configs, and re-verify the full live stack. No CONTINUUM architecture work, no Phase 3 feature work.
**Repo touched:** `TencentDB-Agent-Memory` only.
**Date:** 2026-08-14/15.

---

## 1. Phase 2 commit

Staged **exactly** the 18-file list from `PHASE_2_SECURITY_STABILITY_REPORT.md` §3 — 13 tracked modifications, 2 previously-untracked `windows/*.ps1` scripts, 3 new test files — via explicit `git add <path>...`, never `-A`/`.`. Verified the staged diff stat matched the report's `+366/-33` exactly, and grepped the full staged diff for secret-shaped strings (`sk-...`, `AKID...`, PEM headers, `password=`/`secret=`) before committing; the only hits were four obviously-fake test fixtures (`sk-live-secret-value`, `sk-mem-gateway-secret`, etc.) already present in the new unit tests.

**One thing the review caught before committing:** the `start-proxy.sh` diff also contained an undocumented hunk — `sessionInit.headerAutoSelect.onMismatch` flipped from `"form"` to `"bypass"` — that mapped to no R-item and wasn't mentioned in the Phase 2 report. Investigated rather than silently included or reverted: confirmed all 8 live `.proxy-config/config-*.yaml` files and `windows/Add-TencentProject.ps1`'s template already used `"bypass"` (Tencent/DeepSeek-backed providers don't support the interactive `AskUserQuestion` form the proxy would otherwise show — see `MemoryProxy/src/session/claude-code/init.ts`). Documented as a non-R-item note in `PHASE_2_SECURITY_STABILITY_REPORT.md` §1a and included as-is, since it was already the live, intentional setting.

**Commit:** `ea97ab7645d66316b9eef530a57a38792f83ba30` — "fix(security): close Phase 2 audit findings R-1 through R-14". 18 files, +2434/-33. Not pushed.

Confirmed via `git status --porcelain` before/after: all 19 pre-existing unrelated uncommitted files (the ones `PHASE_2_SECURITY_STABILITY_REPORT.md` §3 lists as "explicitly NOT touched") remained untouched.

## 2. Python3 dependency fix

**Root cause, more precisely than originally flagged:** `start-all.sh` Step 4 parsed `windows/tencent-project-registry.json` with a `python3 -c "..." 2>/dev/null` one-liner. On this machine `python3`/`python` resolve to the Microsoft Store app-execution-alias stub (confirmed: exits 49, prints an install prompt to stderr, zero stdout). The old code assigned the function's output directly — `_registry_projects=$(_parse_registry)` — as a bare statement under `set -euo pipefail`. Bash's `errexit` fires on a bare `var=$(failing_cmd)` assignment (verified empirically: `set -e; f(){ return 49; }; x=$(f); echo unreachable` never printed "unreachable" and exited 49) — so the *real* live symptom wasn't "Step 4 silently reports zero projects," it was **the entire `start-all.sh` process dying immediately at that line, with no error message, skipping Steps' own success output and the final "how to use the proxy" summary.** Steps 1–3 (the core stack) had already completed and kept running; only the tail of the script was lost.

**Fix:** replaced the `python3` one-liner with a `node -e` one-liner in `deploy/global-images/start-all.sh`. `node` is already a hard build/run dependency of this whole stack (MemoryCore/MemoryProxy are TypeScript) — this removes a fragile, absent runtime rather than adding a new dependency. Specifics:
- `command -v node` is checked before parsing; if missing, `die` with an actionable message (install Node, or move the registry aside to skip Step 4) instead of degrading silently.
- The parser reads the file with a manual BOM-strip (`charCodeAt(0) === 0xFEFF`, matching the old `encoding='utf-8-sig'` behavior) and `JSON.parse`s it inside a `try/catch`; on failure it writes `REGISTRY_PARSE_ERROR: <message>` to stderr and exits 1.
- The call site changed from a bare `_registry_projects=$(_parse_registry)` to `if ! _registry_projects=$(_parse_registry); then die "..."; fi` — a malformed registry now fails visibly via a red `[error]` message naming the file and the parse error, instead of silently killing the whole script (verified this control-flow change in isolation: a failing function inside `if ! var=$(...)` is caught, the same pattern with a bare assignment is not).
- Filtering/slug-derivation logic (skip missing port/name, use `containerSlug` or derive from `name`, skip `jarvis`) is unchanged — same behavior, different interpreter.

**Tests:**
- Parsed the real `windows/tencent-project-registry.json` (read-only, never modified) — correctly returned the 7 non-jarvis projects (`quba`, `cars`, `airside`, `albaik`, `hvac`, `avop-android`, `cars-android`) with correct ports/slugs.
- Fed a deliberately malformed JSON file (scratch copy, not the real registry) through the same parser — got `REGISTRY_PARSE_ERROR: Unexpected token...` on stderr and exit 1, and confirmed the `if !` call-site pattern catches this without killing the rest of the script.
- Ran the real `start-all.sh` end-to-end against the live stack (see §4) — Step 4 completed, correctly reported all 7 project proxies "already running", and the script reached the final proxy-usage summary that the old bug would have eaten.

## 3. R-8 migration result

**Scope correction:** "8 existing project YAMLs" in the task brief = the 7 per-project `config-<slug>.yaml` files *plus* the default/jarvis `config.yaml` — all 8 held the literal upstream key. Confirmed via `git grep`-style search (never displaying the value) before starting.

**A second, deeper gap found and fixed:** Phase 2's R-8 fix added `${VAR}` expansion support to `config.ts` and updated `Add-TencentProject.ps1`'s generation template (used for *new* per-project configs) — but `start-proxy.sh`'s own heredoc, which generates the *default* proxy's `config.yaml` fresh on every single run, was never updated. It used an unquoted heredoc (`cat > "$CONFIG_FILE" <<YAML`), so `${PROXY_UPSTREAM_API_KEY}` was bash-expanded to the literal secret at generation time, every time — confirmed live: even the just-freshly-regenerated `config.yaml` still had the literal key baked in, immediately before this fix. Migrating the file alone would have been undone on the next restart.

**Fixes applied:**
- The 7 static `config-<slug>.yaml` files: literal key replaced with the `${PROXY_UPSTREAM_API_KEY}` placeholder via a one-off Node script (`r8_migrate.js`, scratch-only, not committed) that reads the real key from `.env` in-process and never prints it — only file-name/count output. Backup of the pre-migration `.proxy-config/` taken first and moved to `_quarantine\2026-08-14_R-8_proxy-config-backup-pre-migration\` (out-of-repo, following the R-1 quarantine convention — the working copy inside the repo tree is untracked but not gitignored under that name, so it was moved out rather than left there).
- `deploy/global-images/start-proxy.sh`: the heredoc's `apiKey` line now writes an escaped `\${PROXY_UPSTREAM_API_KEY}` literal instead of letting bash expand it, and the `docker run` for the default proxy now passes `-e "PROXY_UPSTREAM_API_KEY=${PROXY_UPSTREAM_API_KEY:-}"` (previously missing entirely for this one container — every other creation path already had it).

**Live verification — every one of the 8 configs, after the fix:**
| Config | Placeholder present | Container | Upstream connectivity (post-restart) |
|---|---|---|---|
| `config.yaml` (default/jarvis) | ✅ (survived a full regeneration via `start-proxy.sh`) | `tdai-proxy` | `ok (415ms)` |
| `config-quba.yaml` | ✅ | `tdai-proxy-quba` | `ok (416ms)` |
| `config-cars.yaml` | ✅ | `tdai-proxy-cars` | `ok (386ms)` |
| `config-airside.yaml` | ✅ | `tdai-proxy-airside` | `ok (361ms)` |
| `config-albaik.yaml` | ✅ | `tdai-proxy-albaik` | `ok (480ms)` |
| `config-hvac.yaml` | ✅ | `tdai-proxy-hvac` | `ok (425ms)` |
| `config-avop-android.yaml` | ✅ | `tdai-proxy-avop-android` | `ok (409ms)` |
| `config-cars-android.yaml` | ✅ | `tdai-proxy-cars-android` | `ok (419ms)` |

The 7 project containers already had `PROXY_UPSTREAM_API_KEY` set in their environment (from earlier Phase 2 live testing), so a plain `docker restart` was sufficient to pick up the new placeholder config — no recreation needed for those. The default proxy needed recreation (via `start-proxy.sh`) since it needed the new `-e` flag added to its `docker run`. No ports, task IDs, routing, or project identity changed on any container.

No `sk-`-shaped strings found in a full-history grep of any of the 10 live containers' logs after these restarts.

## 4. Live stack verification

Docker Desktop was found not running at the start of this session (Windows-side pipe unreachable; the WSL2 backend/containers turned out to still be live underneath). Starting the Docker Desktop GUI to reconnect triggered an engine reconciliation that stopped the 3 core containers (`tdai-memory-core`, `tdai-memory-hub`, `tdai-proxy` — these have no restart policy) while the 7 project proxies (`--restart unless-stopped`) auto-recovered on their own. Brought the core stack back up with the repo's own `./start-all.sh` — the same, documented recovery path this stack already uses — which also served as the real-registry test for the §2 fix.

- **10/10 containers healthy**, confirmed via `docker ps`.
- **All 11 ports loopback-only** (`127.0.0.1:*`), confirmed via `netstat -ano | grep LISTENING` before and after the R-8 container restarts.
- **`verify.sh` (R-13's fixed port-check) run live:** correctly reported all 4 core ports as occupied (expected — the stack is up) via the `netstat` fallback path, and both LLM connectivity checks (memory + proxy groups, from-container and from-host) passed.
- **Authenticated Proxy → MemoryCore (R-4):** every one of the 8 proxies' own startup connectivity check reports `"auth":"ok"` — this is the exact code path R-4 fixed (proxy sending its `serviceToken` Bearer to MemoryCore's auth-gated `/v3/meta/auth/verify`), now exercised live across all 8, not just the 2 test containers Phase 2 used.
- **Memory capture/recall:** live round-trip against `POST /capture` then `POST /search/conversations` on `tdai-memory-core`, using a disposable, uniquely-tagged marker (`session_key: test-session-phase21-verify-<timestamp>`). Capture returned `{"l0_recorded":2,"scheduler_notified":true}`; the search call found the marker. **Not cleaned up afterward** — `/v3/conversation/delete` requires `team_id`/`agent_id`/`user_id` isolation fields, and guessing at those to delete a tiny disposable test record felt like a worse risk than leaving it (unlike Phase 2's equivalent test, which had a clear teardown path). Flagging this explicitly rather than silently claiming cleanup that didn't happen.
- **Unit/regression (vitest, MemoryProxy):** 54/54 passing — identical count to Phase 2's baseline, zero regressions from either the `start-all.sh`/`start-proxy.sh` changes (shell-only, no `.ts` touched) or the live config migration.
- **No secrets in logs or diffs:** confirmed across all 10 containers' full logs (§3) and the staged Phase 2.1 diff (§6).

## 5. Files changed (Phase 2.1)

- `deploy/global-images/start-all.sh` — §2 (python3→node registry parsing, visible-failure control flow).
- `deploy/global-images/start-proxy.sh` — §3 (heredoc placeholder fix + missing `-e PROXY_UPSTREAM_API_KEY`).
- `CONTINUUM/docs/PHASE_2_SECURITY_STABILITY_REPORT.md` — added §1a documenting the `onMismatch` hunk (see §1 above).
- `CONTINUUM/docs/PHASE_2_1_BASELINE_CLOSURE.md` — this file.
- **Not committed (deliberately):** the 8 live `deploy/global-images/.proxy-config/*.yaml` files are runtime state, gitignored, and were never meant to be tracked — the migration is a live-config change, not a source change. The one-off `r8_migrate.js` migration script lived only in the session scratch directory and was never added to the repo.

## 6. Phase 2.1 commit

Staged only the 4 files in §5 explicitly (never `-A`/`.`). Diff reviewed for secrets before committing — none found (the only string resembling a key in the diff is the literal placeholder text `${PROXY_UPSTREAM_API_KEY}`, not a value).

## 7. Remaining risks (carried over or newly noted)

- **R-6** (static default credentials) — still contained, not eliminated, unchanged from Phase 2. Rotation remains un-authorized/out of scope.
- **Registration/idempotent-re-registration live test** — still deliberately not run (Phase 2's reasoning stands: creates persistent external Tencent metadata with no clean teardown).
- **The disposable memory-core test record from §4** — left in place; low-risk (inert, uniquely tagged, isolated to a test `session_key`) but real residue. Worth a follow-up if a safe, well-understood delete path is established later.
- **Docker Desktop's no-restart-policy on the 3 core containers** — not fixed (out of scope for this closure), but now documented as the mechanism by which the core stack goes down whenever Docker Desktop restarts, while project proxies auto-recover. `./start-all.sh` is the correct, already-idempotent recovery path; the Phase 2 report's original suggestion to fold Health/Recovery consolidation into early Phase 3 work remains reasonable.
- **`start-proxy.sh`'s `onMismatch: "bypass"` default** — confirmed intentional (§1), not a risk, but flagging that this proxy-wide setting means identity-header mismatches are never surfaced to an operator via the interactive form on Tencent/DeepSeek-routed sessions; that's accepted behavior per the provider constraint, not a gap.

## 8. Baseline readiness for Phase 3

All items in the Phase 2.1 task brief are closed and live-verified: Phase 2 committed cleanly, the `python3` failure is fixed and tested against the real registry, R-8 migration is complete and verified across all 8 live configs, and the full stack (10/10 containers, all loopback-only, auth path, memory capture/recall, regression suite) is healthy. **Baseline is ready for Phase 3 (Provider Adapter foundation), per `PHASE_3_ENTRY_CRITERIA.md`'s original recommendation.** Per this task's explicit instructions, Phase 3 work itself has not been started.
