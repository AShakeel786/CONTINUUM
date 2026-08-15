# Phase 2 — Test Matrix

Every item from the task's "Baseline + Verification" checklist, with method, evidence, and result. "Live" = tested against real Docker containers built from the patched source (not mocked). "Unit" = vitest, mocked I/O.

## Baseline (captured before any change)

| Item | Result |
|---|---|
| Containers/health | 10/10 `tdai-*` containers healthy: `tdai-memory-core`, `tdai-memory-hub`, `tdai-proxy`, `tdai-proxy-{quba,cars,airside,albaik,hvac,avop-android,cars-android}` |
| Ports | 8420 (core), 8096 (default proxy), 8125+8424 (hub), 8097–8103 (7 project proxies) — all `docker ps` showed `127.0.0.1:...`; confirmed via `netstat` at the OS level too |
| Registry/projects | 8 projects in `windows/tencent-project-registry.json`: quba/8099, cars/8097, airside/8100, jarvis/8096, albaik/8101, hvac/8098, avop-android/8102, cars-android/8103 |
| MemoryProxy tests | 43/43 passing (pre-existing suite, before any Phase 2 change) |
| Admin key file | Present, non-empty (value never read/printed) |
| Git status, both repos | Recorded; CONTINUUM had only Phase 1 docs untracked; Tencent repo had 19 pre-existing modified/untracked files (listed in `PHASE_2_SECURITY_STABILITY_REPORT.md` §3) — none touched by this phase |

## Per-finding verification

| Finding | Method | Result |
|---|---|---|
| **R-1** | `git log --all --full-history -- backups/` (empty = never committed); `git check-ignore -v` before/after; file move + repo re-scan | Confirmed never in history. `backups/` now ignored (`git check-ignore` exit 0 on a nested test path post-fix, exit 1 pre-fix). Artifact confirmed absent from repo tree post-move (`find backups -iname "*bypass-all-agents*"` returns only an unrelated empty dir). |
| **R-2** | Unit (`tsc --noEmit`, clean); **Live** — 3 real proxy container scenarios | (a) `server.host=0.0.0.0`, no `admin.apiKey` → refuses, `Exited (1)`, port serves nothing. (b) Same host, `admin.apiKey` unset but this is the *standard* Docker pattern → after the guard correction, starts and reaches `healthy`. (c) Real E2E test container (auth flow, see R-4) also confirms normal startup with the realistic config. |
| **R-3** | **Live** — 3 real memory-core container scenarios | (a) `TDAI_GATEWAY_HOST=0.0.0.0`, no key → after correction, starts healthy (standard Docker pattern, safe by convention). (b) `TDAI_GATEWAY_HOST=192.168.1.50` (genuinely unusual, explicit non-loopback/non-0.0.0.0), no key → refuses, `Exited (1)`, error message names the exact host and remediation options. (c) `TDAI_GATEWAY_HOST=127.0.0.1` (the real live deployment's actual setting), no key → starts healthy (compatibility preserved). |
| **R-4** | Unit — 5 tests mocking `fetch`, covering: header sent when `serviceToken` set, header omitted when not, gateway-rejection handled, invalid-user_key handled, auth-disabled passthrough. **Live** — 2 real containers (memory-core with `TDAI_GATEWAY_API_KEY` set, two proxy variants) | Unit: 5/5 pass. Live: identical request/target, only `serviceToken` configured or not — **without**: `"Authentication failed: auth service returned HTTP 401"` (gateway's own auth gate blocking, i.e. the bug). **With**: `"Authentication failed: invalid user_key"` (reaches the real check — the fix). This is the clearest possible before/after proof, on real containers. |
| **R-5** | Code diff + **live**: `docker inspect` port bindings + OS-level `netstat` after redeploy | `start-memory-hub.sh` now publishes `127.0.0.1:${PANEL_PORT}:8125` / `127.0.0.1:${KNOWLEDGE_PORT}:8424`. Post-redeploy `netstat` confirms both ports genuinely loopback-only on the Windows host (not just `docker ps` display, which can mislead — see Phase 1 audit notes on this exact ambiguity). |
| **R-6** | Reasoning documented (no independent test — this finding is addressed by containment via R-2/R-3, not elimination) | See `PHASE_2_SECURITY_STABILITY_REPORT.md` §6. |
| **R-7** | Code diff + live redeploy output inspection | `start-all.sh`'s final summary output, captured during the real redeploy, contains `export ANTHROPIC_AUTH_TOKEN="$(cat .admin-key)"` — no literal key value anywhere in the captured log. |
| **R-8** | Unit — 3 tests (`${VAR}` resolves from env, plain literal still works unchanged, unset var resolves to empty not the placeholder text) | 3/3 pass. Live: all 8 real project proxy containers recreated on the rebuilt image using their **existing** (literal-value, pre-fix-format) YAML files — started healthy, proving the backward-compatibility claim (a literal value with no `${...}` is untouched by `expandEnv`). |
| **R-9** | Unit — 3 tests: known sensitive headers redacted, secret value never appears anywhere in the serialized stored buffer (`JSON.stringify` substring check), case-insensitive header matching | 3/3 pass. |
| **R-12** | Static trace (syntax-checked via `PSParser::Tokenize`) + manual code-flow verification | Self-heal block confirmed to now execute only after `$AgentChoice` is guaranteed non-null (traced every branch of Agent Selection to confirm no path leaves it unset by that point). Not exercised via the actual interactive launcher (would require live human input at a menu prompt) — verified by code inspection instead. |
| **R-13** | **Live** — real occupied port (8420, the running memory-core) and a real free port (54321) | Correctly reports 8420 as occupied (WARN) and 54321 as free (OK). Confirmed `lsof` absent on this exact machine (the platform R-13 is about) and that the new `netstat`-based path is what actually ran. |
| **R-14** | **Live** — real healthy proxy (8096) and a disposable Node HTTP server simulating a 500 response | New check: `True` for the healthy proxy, `False` for the simulated 500. Old check (kept side-by-side for the test only, not in the shipped code) returned `True` for the same 500 response — direct proof of what the bug was and that it's fixed. |

## Post-change full verification matrix

| Item | Method | Result |
|---|---|---|
| Authenticated Proxy → MemoryCore communication | Live, disposable containers (see R-4 above) | Confirmed working |
| Invalid credentials rejected | Live — wrong Bearer key against real memory-core `/v3/meta/auth/verify` | `401 invalid token` |
| Default + all registered project proxies healthy | Live — full redeploy, all 10 containers | 10/10 healthy, all 11 health endpoints (incl. panel/knowledge) return 200 |
| Memory injection/L0 capture still work | Live — real memory-core, disposable uniquely-tagged test space (`phase2verify<timestamp>`), not touching real project data | Write (`/v2/conversation/add`) → 200, accepted. Search (`/v2/conversation/search`) → found the marker. Deleted afterward (`/v2/conversation/delete` → `deleted_count: 1`), no residue left. |
| Launcher/project resolution works | Static trace + syntax check (`launch-tencent-claude.ps1` parses cleanly post-edit; project-resolution logic untouched by this phase) | Not exercised interactively (would require live human menu input) — code-path unchanged except the two specifically-fixed functions, both independently verified above |
| Self-heal works for stopped and missing disposable project proxy | Live — `docker restart tdai-proxy-hvac` (a real, non-disposable project, but restart is non-destructive/expected-recoverable, not a "break it" test); missing-config path tested via isolated PowerShell harness against a nonexistent file | Restart: healthy again within ~8s, health endpoint 200. Missing-config: precise, actionable failure message, no exception, clean `$false` return. |
| Missing YAML gives precise failure | See above | Confirmed |
| Docker restart recovery | See above | Confirmed |
| Registration + idempotent re-registration | **Not performed live.** A successful `Add-TencentProject.ps1` run creates persistent Tencent-side task/team-agent-link metadata with no automated teardown found in this codebase (only failure-path rollback exists). Running it live for verification purposes, without a specific go-ahead for that side effect, felt like it exceeded what "hardening verification" should authorize on its own. | Verified via code review of the registration script's idempotency check (`if ($existingYaml -match "task_id:\s*\"$taskId\"") { skip generation }`) and via the R-8 unit tests, which cover the config-generation logic this script depends on. **Flagged as a gap, not silently marked done.** |
| No plaintext secrets/log leakage | Live — grepped fresh container logs (`memory-core`, `memory-hub`, `proxy`, one project proxy) for `authorization\|bearer\|api.?key\|serviceToken` patterns, excluding known-safe matches (`disabled`, `not set`) | Zero matches |
| No unintended network exposure | Live — `netstat -ano` on the Windows host for all 11 live ports, post-redeploy | All 11 confirmed `127.0.0.1:<port>` only |

## Test file inventory

New (this phase): `MemoryProxy/src/__tests__/auth-serviceToken.test.ts` (5 tests), `identity-redaction.test.ts` (3 tests), `upstream-apikey-expand.test.ts` (3 tests) — 11 total.
Pre-existing, untouched: `fallback-edge-cases.test.ts` (28), `fallback-smoke.test.ts` (5), `tryHistoryScan-taskid.test.ts` (10) — 43 total.
**Final count: 54/54 passing, zero regressions.**

## Rollback safety net established

- `agentmemory/memory-hub:pre-phase2-rollback` and `agentmemory/memory-proxy:pre-phase2-rollback` — successfully tagged from the exact image digests the live containers were running before this phase's rebuild.
- `agentmemory/memory-core`'s pre-rebuild digest (`sha256:7f0b1aa0...`) could **not** be independently retagged locally (it resolved as a manifest-list digest with no standalone local image entry after the rebuild superseded `:latest`). If a rollback of memory-core is ever needed, the fallback is `docker pull agentmemory/memory-core:latest` from the public registry (the standard source this deployment already pulls from when `PULL=1`), which should match what was running pre-Phase-2 since no local customization of that image predates this session.
