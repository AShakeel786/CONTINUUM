# Phase 2 — Security & Stability Closure Report

**Scope:** hardening only, against the 11 findings from Phase 1's `RISKS_AND_TECH_DEBT.md` (R-1, R-2, R-3, R-4, R-5, R-6, R-7, R-8, R-9, R-12, R-13, R-14). No CONTINUUM architecture, no refactor beyond what each fix required, no unrelated changes.
**Repo touched:** `TencentDB-Agent-Memory` only. `CONTINUUM` received this doc set only.
**Date:** 2026-08-14

---

## 1. Fixes made

| Finding | Fix | Where |
|---|---|---|
| **R-1** | Credential-shaped untracked file (plausible Codex `config.toml` copy, 28,564 bytes, never in git history — confirmed via `git log --all --full-history`) moved to an out-of-repo quarantine folder with a dated explainer, not deleted. `backups/` added to `.gitignore`. | `.gitignore`; artifact moved to `C:\Users\<user>\Documents\Ai-tools\_quarantine\2026-08-14_R-1_codex-config-leak\` |
| **R-2** | MemoryProxy admin ops routes were open-by-default with no startup warning despite a code comment claiming one existed. Added the missing warning, plus a fail-closed startup guard: refuses to start if bound beyond loopback/Docker-standard `0.0.0.0` with no `admin.apiKey` and no explicit override. | `MemoryProxy/src/index.ts`, `src/types.ts`, `src/config.ts` |
| **R-3** | Same fail-closed pattern for MemoryCore's Gateway (`TDAI_GATEWAY_API_KEY`). | `MemoryCore/src/gateway/server.ts`, `src/gateway/config.ts` |
| **R-4** | `MemoryProxy/src/auth.ts`'s `verifyUserKey()` sent no `Authorization` header to MemoryCore's `/v3/meta/auth/verify`, so the Gateway's own auth gate would reject the call before the user_key check ever ran, whenever gateway auth was enabled. Added `AuthConfig.serviceToken`, wired through with a backward-compatible fallback to the already-populated `skill.serviceToken`, and send the Bearer header when present. | `MemoryProxy/src/auth.ts`, `src/types.ts`, `src/config.ts`, `deploy/global-images/start-proxy.sh`, `windows/Add-TencentProject.ps1` (template), `deploy/global-images/start-memory-core.sh` (stale warning comment corrected) |
| **R-5** | `start-memory-hub.sh` published Panel (8125) and Knowledge (8424) on all interfaces by default, unlike memory-core/proxy which were already loopback-scoped. Now `127.0.0.1:<port>`. | `deploy/global-images/start-memory-hub.sh` |
| **R-6** | Static default credentials (`local`, `admin`) are addressed by containment rather than rotation (rotating a live credential wasn't authorized): R-2/R-3's fail-closed guards mean these defaults can no longer be silently exposed beyond loopback without an explicit opt-in. | (covered by R-2/R-3 fixes) |
| **R-7** | `start-all.sh`'s final summary printed the admin key in full plaintext, inconsistent with `start-memory-core.sh`'s deliberate masking a few lines earlier. Changed the printed command to read the key from its file at execution time (`$(cat $ADMIN_KEY_FILE)`) instead of embedding the literal value — still copy-pasteable, never touches terminal scrollback. | `deploy/global-images/start-all.sh` |
| **R-8** | Per-project `config-<slug>.yaml` files each baked in a plaintext copy of the real upstream LLM API key (8 duplicated copies). Added `${VAR}` expansion support to `upstream.apiKey` (reusing the proxy's existing `expandEnv()` helper, previously only applied to `systemUsers`), changed the generation templates to write a `${PROXY_UPSTREAM_API_KEY}` placeholder instead of the literal value, and pass the real value via `docker run -e` at every container-creation call site (`Add-TencentProject.ps1`, `start-all.sh` Step 4, `launch-tencent-claude.ps1`'s `Repair-ProjectProxy`). Fully backward compatible — a plain literal value with no `${...}` still works unchanged. The 8 already-generated live YAML files were **not** retroactively rewritten (would require recreating all 8 containers' configs beyond what this fix needed); they keep working as literal values. | `MemoryProxy/src/config.ts`, `windows/Add-TencentProject.ps1`, `deploy/global-images/start-all.sh`, `windows/launch-tencent-claude.ps1` |
| **R-9** | `MemoryProxy/src/identity.ts`'s `recentInspections` debug ring buffer stored full raw request headers, including `Authorization`/`x-api-key`/`x-tdai-user-key`, unredacted. Added `redactSensitiveHeaders()`, applied centrally in `recordInspection()`. | `MemoryProxy/src/identity.ts` |
| **R-12** | Per-project proxy self-heal in the launcher was gated on `$AgentChoice`, which wasn't assigned until later in the script — the branch could never fire. Moved the self-heal block to run after Agent Selection is finalized. | `windows/launch-tencent-claude.ps1` |
| **R-13** | `verify.sh`'s port-availability check used `lsof`, absent by default on Windows/Git-Bash — the exact platform this repo runs on — causing occupied ports to be silently reported free. Added a `netstat`-based fallback (single cached call, not per-port, since `netstat` is slow on this machine), with an explicit "cannot determine" warning if neither tool is available. | `deploy/global-images/verify.sh` |
| **R-14** | `Test-ProxyHealth` in the launcher POSTed to the messages endpoint and accepted *any* HTTP response — including 401/500 — as healthy. Rewrote to call the real `/health` endpoint (the same one Docker's own `HEALTHCHECK` uses) and require `{"status":"ok"}`. | `windows/launch-tencent-claude.ps1` |

## 1a. Note on a non-R-item hunk in this diff (`start-proxy.sh`)

The `start-proxy.sh` diff (touched for R-4's `serviceToken` line) also flips the generated config template's `sessionInit.headerAutoSelect.onMismatch` from `"form"` to `"bypass"`. **This is not an R-1–R-14 fix and not new Phase 2 security work** — flagging it explicitly so it isn't mistaken for one.

`onMismatch` controls what happens when a request's team/agent/task identity headers don't match a known preset: `"form"` falls back to an interactive identity-confirmation form; `"bypass"` skips that check. Tencent/DeepSeek-backed providers don't support the interactive `AskUserQuestion` form the proxy would otherwise show (see the comment in `MemoryProxy/src/session/claude-code/init.ts` around `onMismatch === "bypass"`), so `bypass` is a pre-existing, intentional compatibility requirement for this deployment, not a security loosening introduced here.

Verified before inclusion in the Phase 2.1 commit: all 8 live deployed proxy configs (`deploy/global-images/.proxy-config/config-*.yaml` — the 7 named project configs plus the default `config.yaml`) already had `onMismatch: "bypass"` set, and `windows/Add-TencentProject.ps1`'s generation template matches. The `start-proxy.sh` template was simply out of sync with what was already live; this hunk brings it in line with the other two, not the other way around.

## 2. A bug I introduced and caught before it shipped

R-2/R-3's first version checked "is `server.host` loopback?" and hard-failed otherwise. That's wrong for this codebase: every container in this deployment binds `0.0.0.0` **internally** by Docker necessity (port-publishing can't forward to a container's literal `127.0.0.1`), and the real exposure boundary is the **host-side** `-p 127.0.0.1:...` bind, which the app process can't see. As written, the guard would have refused to start on 100% of real containers in this system. Caught via live-container testing (§4) before touching the real stack — rebuilt with `0.0.0.0`/`::` reclassified as safe-by-convention alongside true loopback, re-verified, then deployed. See `windows/launch-tencent-claude.ps1`, `MemoryCore/src/gateway/server.ts`, `MemoryProxy/src/index.ts` comments for the reasoning left in place for future readers.

## 3. Files changed

**Tracked, modified (13 files, +366/-33 lines):** `.gitignore`, `MemoryCore/src/gateway/{config,server}.ts`, `MemoryProxy/src/{auth,config,identity,index,types}.ts`, `deploy/global-images/{start-all,start-memory-core,start-memory-hub,start-proxy,verify}.sh`.

**Untracked (windows/ isn't in git at all — see Phase 1 audit), modified:** `windows/launch-tencent-claude.ps1`, `windows/Add-TencentProject.ps1`.

**New test files (3):** `MemoryProxy/src/__tests__/{auth-serviceToken,identity-redaction,upstream-apikey-expand}.test.ts`. These sit alongside 3 **pre-existing** untracked test files (`fallback-edge-cases`, `fallback-smoke`, `tryHistoryScan-taskid`) that were already there before this session — not mine, not touched.

**Explicitly NOT touched:** the 6 other pre-existing modified files from before this session (`MemoryCore/src/core/{profile/profile-sync,scene/scene-format,scene/scene-index,store/types}.ts`, `MemoryCore/src/gateway/{v2-router,v2-schemas}.ts`, `MemoryProxy/src/{injection/injectors/tdai-fixed-asset,injection/injectors/tdai-profile-memory-injector,memory/memory-bridge,session/claude-code/form,session/claude-code/init,session/store,tdai/client,tdai/types}.ts`, `MemoryProxy/package-lock.json`) and the pre-existing untracked `UNIFIED_AGENT_LAUNCHER_REPORT.md`, `deploy/global-images/windows/`. Confirmed via `git status --porcelain` before and after — identical set, none of it mine.

**Images rebuilt and deployed:** `agentmemory/memory-core:latest`, `agentmemory/memory-proxy:latest` (rebuilt twice — the first build had the guard bug from §2; the second is what's live). Pre-fix image digests preserved as `:pre-phase2-rollback` tags for memory-hub and memory-proxy (memory-core's digest wasn't independently taggable locally — see `PHASE_2_TEST_MATRIX.md`).

## 4. Tests and results

- **Unit/regression (vitest):** 54/54 passing (43 pre-existing + 11 new across the 3 new test files). Zero regressions. Full detail: `PHASE_2_TEST_MATRIX.md`.
- **Live container verification (real, not mocked):** R-3's corrected guard tested against 4 real container scenarios (genuinely dangerous host → refuses; standard Docker `0.0.0.0` → starts; key present → starts; real live-config match → starts). R-4 tested end-to-end with two real containers and a definitive before/after comparison (`"auth service returned HTTP 401"` without the fix vs `"invalid user_key"` with it — same request, same target, only `serviceToken` differs). R-13 and R-14 each tested against a real occupied port / real unhealthy response.
- **Full stack redeploy:** both rebuilt images deployed to the actual live stack (all 10 containers: memory-core, memory-hub, default proxy, and all 7 project proxies). All healthy. All 11 health endpoints return 200. All ports confirmed loopback-only via `netstat` (not just `docker ps` display). Zero secret/credential strings found in fresh container logs. Real memory capture+recall (L0 write, search, delete) round-tripped successfully through the rebuilt memory-core using a disposable, uniquely-tagged test space — cleaned up afterward. Docker restart recovery confirmed on a live project proxy. Missing-YAML failure path confirmed precise.

## 5. Before / after status

| | Before | After |
|---|---|---|
| Credential-shaped file in repo tree | Untracked, not gitignored, one `git add -A` from being committed | Quarantined outside repo; `backups/` gitignored |
| Proxy admin routes, non-loopback + no key | Open, no warning (despite a comment claiming one) | Warned always; refuses to start unless loopback/Docker-standard bind or explicit override |
| Gateway, non-loopback + no key | Warned only | Same fail-closed pattern |
| memory-hub bind scope | All interfaces by default | Loopback-only, matching memory-core/proxy |
| Proxy→Core auth with gateway auth enabled | Always rejected (missing Bearer) — proven live | Succeeds — proven live, same real containers, before/after comparison |
| Admin key in `start-all.sh` output | Full plaintext | Never appears in output; command reads from file at exec time |
| Upstream LLM key duplication | 8 plaintext copies on disk | `${VAR}` placeholder support added; new/regenerated configs use it; existing 8 left as-is (not retroactively rewritten) |
| Debug header buffer | Raw `Authorization`/`x-api-key`/etc. stored unredacted | Redacted before storage, tested |
| Per-project proxy self-heal | Dead code (wrong variable ordering) | Fires correctly |
| Port-check on this exact platform | Silent false negative (lsof absent) | Correct on both occupied and free ports (proven live) |
| Proxy health check | Accepted any HTTP response including 500 | Requires genuine `{"status":"ok"}` (proven live against a simulated 500) |
| Live deployment | 10/10 containers healthy | 10/10 containers healthy, on rebuilt images, zero regressions |

## 6. Remaining risks

- **R-6** is contained, not eliminated: `local`/`admin` default credentials still exist in `.env`/deploy scripts. Rotating them wasn't authorized in this phase ("do not automatically rotate credentials"). They're now meaningfully less dangerous since R-2/R-3 prevent them from being silently exposed beyond loopback, but an operator who explicitly sets `TDAI_GATEWAY_ALLOW_INSECURE_BIND=true` (or the proxy equivalent) with the default key still creates real exposure — that's now a deliberate, explicit choice rather than a silent default, which was the actual goal, but the underlying weak credential remains.
- **R-8's 8 existing per-project YAML files** still hold literal (not placeholder) upstream keys — the mechanism to reduce duplication now exists for new/regenerated configs, but wasn't backported to live files (would require recreating all 8, a broader action than this fix needed).
- **The `python3` issue found live during this phase** (Windows Store stub, not real Python — causes `start-all.sh` Step 4's registry-driven project-proxy sync to silently do nothing) is a real, currently-live gap, but it's the pre-existing R-29/R-33 finding from Phase 1, not one of the 11 items in this phase's scope. Flagged here for visibility; not fixed.
- **Registration + idempotent re-registration** (one item in the task's verification checklist) was deliberately **not** run live against real Tencent task/team infrastructure — a successful registration creates persistent external metadata with no clean automated teardown found in this codebase, and doing that without specific approval felt outside what "verification" should authorize on its own. Verified instead via code review + the YAML-generation/backward-compatibility unit tests (R-8's tests). See `PHASE_2_TEST_MATRIX.md` for the detail and rationale — flagging this explicitly rather than silently marking it done.

## 7. Pass / fail

**PHASE 2 PASSED**, with the one documented, deliberate scope exception in §6 (live registration test). All 11 in-scope findings (R-1 through R-14, excluding R-10/R-11 which were never in scope) are fixed, tested, and verified against the real live stack with zero regressions and zero unrelated modifications. If you want the registration test run live too, say so and I'll scope that as a small follow-up with its own explicit go-ahead, given it creates real external state.

## 8. Files ready to commit

All 13 tracked modified files plus 2 untracked `windows/` scripts plus 3 new test files, listed in §3. **Nothing has been staged or committed** — per the task's rules, `git add -A`/`git add .` were never used, and no commit was made. If you want to commit, I'd stage exactly this list explicitly, not a broad add, given the pre-existing unrelated uncommitted changes sitting in the same working tree.

## 9. Recommended Phase 3 entry point

See `PHASE_3_ENTRY_CRITERIA.md`.
