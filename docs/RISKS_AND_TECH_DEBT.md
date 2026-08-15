# Risks & Technical Debt — TencentDB Agent Memory (as audited)

All findings below are **verified by reading source**, cited to file/path. None have been fixed as part of this audit (Phase 1 is read-only by instruction). Severity is my assessment for the purpose of Phase 2 prioritization, not an upstream/Tencent classification.

Legend: 🔴 High (security exposure or active correctness bug) · 🟡 Medium (fragility, would break under a plausible real-world action) · ⚪ Low (debt/duplication, no near-term failure mode)

---

## Security

**R-1 🔴 Untracked credential-shaped file sitting in the repo tree, not gitignored.**
`backups\2026-08-09_bypass-all-agents\<garbled filename>` — the filename is the mangled text of a failed `cp C:\Users\arsla\.codex\config.toml ...` command (cross-shell path-quoting accident). Content wasn't opened (per audit instructions), but the filename strongly implies a raw copy of Codex's credential file. `backups/` is not covered by `.gitignore` and the file is currently untracked (`??`). A broad `git add -A`/`git add .` in this repo would commit it.
*Recommendation:* delete the file or add `backups/` to `.gitignore` before any further git operations in that repo.

**R-2 🔴 MemoryProxy admin endpoints are open-by-default.**
`admin.apiKey` defaults to `""` (`MemoryProxy/src/config.ts`). If neither `TDAI_PROXY_ADMIN_API_KEY` env nor YAML `admin.apiKey` is set, ops routes (e.g. `/v3/instance/proxy-destroy`) are publicly reachable with no auth, "by design, relying on network isolation." Dangerous if any of the per-project containers is ever exposed beyond `127.0.0.1`.

**R-3 🔴 MemoryCore Gateway auth is off by default.**
`TdaiGateway.logSecurityPosture()` (`MemoryCore/src/gateway/server.ts`) warns loudly at startup when `TDAI_GATEWAY_API_KEY` is unset — "all routes except GET /health are open to anyone who can reach this port" — but this is a *log warning*, not an enforced gate. Default posture is unauthenticated.

**R-4 🔴 The "secure" configuration currently does not work.**
If `MEMORY_CORE_GATEWAY_API_KEY` is set non-empty, a source bug in `MemoryProxy/src/auth.ts` omits the Bearer header on the proxy's `auth.verify` call to MemoryCore, breaking auth entirely (documented in `deploy/global-images/start-memory-core.sh` comments). The deploy scripts default to an empty/`local` key specifically to route around this bug — meaning the insecure default is load-bearing, not incidental.

**R-5 🟡 Inconsistent network bind-scoping across services.**
`start-memory-core.sh` and `start-proxy.sh` bind `127.0.0.1:<port>` (loopback-only). `start-memory-hub.sh` binds both `PANEL_PORT` and `KNOWLEDGE_PORT` **without** the loopback prefix — i.e., all interfaces, by default. This means the admin Panel UI and the Knowledge API (the two surfaces most likely to carry sensitive control-plane actions) are the most exposed of the four ports, while carrying default `admin`/`local`-equivalent credentials (see R-6).

**R-6 🟡 Static, well-known default credentials.**
`MEMORY_CORE_GATEWAY_API_KEY` defaults to the literal string `"local"` (`start-memory-hub.sh`, `start-proxy.sh`); admin username/key also default to well-known values per `deploy/global-images/README.md`, which explicitly flags this as unsafe beyond single-user local use — but no script enforces rotation before wider exposure.

**R-7 🟡 Admin key printed to terminal in full plaintext, inconsistently.**
`start-memory-core.sh` deliberately masks the admin key when logging it ("so it doesn't stay in terminal history"). Moments later, `start-all.sh`'s final summary echoes the **same key, unmasked**, into terminal output (and thus likely shell history / terminal scrollback logging).

**R-8 🟡 Per-project plaintext credential duplication.**
`Add-TencentProject.ps1` writes the upstream LLM API key into a new per-project `config-<slug>.yaml` on every project registration — the same secret ends up duplicated in N files on disk (one per project), increasing blast radius of any single leak.

**R-9 ⚪ Dormant raw-header capture buffer in MemoryProxy.**
`MemoryProxy/src/identity.ts` — a module-level `recentInspections` ring buffer (cap 20) stores full raw request headers, including `Authorization`/`x-api-key`/`x-tdai-user-key`, without redaction. `getRecentInspections()` is exported but currently unused by any route. Not actively leaking today, but it's a ready-made "dump last 20 requests with live API keys" function one wiring mistake away from being an unauthenticated leak endpoint, given the proxy also has an admin-auth-gated ops surface.
*Recommendation:* remove, or redact before storing.

**R-10 ⚪ Unconditional permission/sandbox-bypass on every launch.**
All three agent paths in `windows/launch-tencent-claude.ps1` pass `--permission-mode bypassPermissions` (Claude) or `--dangerously-bypass-approvals-and-sandbox` (Codex) with no confirmation prompt and no safer default mode offered.

**R-11 ⚪ Stray non-gitignored empty artifact directories from prior path-mangling bugs.**
`deploy/global-images/.admin-key;C`, `.proxy-config${cfg}` (literal unexpanded variable in a directory name), `windows/__tdam_auto_key.js;C` — physical evidence that the `to_win_path()` MSYS/Git-Bash workaround used in some scripts (`start-memory-core.sh`, `start-proxy.sh`) is not applied everywhere, and that this has already caused corrupted on-disk state in this exact checkout.

---

## Correctness Bugs

**R-12 🔴 Dead self-heal branch in the launcher (confirmed logic bug).**
`windows\launch-tencent-claude.ps1` — a per-project proxy repair-on-launch branch is gated on `if ($AgentChoice -eq "deepseek" ...)`, but `$AgentChoice` is not assigned until the Agent Selection step, which runs **later** in the script. At the point this branch executes, `$AgentChoice` is always unset, so this branch can never fire. Practical effect: if the *default* proxy (8096) is healthy but a *specific project's* proxy is down, this system does **not** actually self-heal it despite the code appearing to.
*Recommendation:* fix by reordering (agent selection before project-apply) or removing the dead gate — but not as part of Phase 1 (audit-only).

**R-13 🟡 Port-check false negative on the exact platform this system runs on.**
`deploy/global-images/verify.sh` uses `lsof` to check port availability. `lsof` is not present by default on Windows/Git-Bash/MSYS. When the command isn't found, the `if` evaluates false and the script reports the port as **free even when it's occupied** — a silent false negative specifically on Windows, the platform this repo is deployed on.

**R-14 ⚪ `Test-ProxyHealth` accepts any HTTP response as "healthy."**
Including 401s and 500s (`launch-tencent-claude.ps1`) — it only distinguishes "got a response" from "connection refused/timeout." A crash-looping-but-still-listening proxy, or one consistently 500ing, is reported healthy.

**R-15 ⚪ No file locking on registry writes.**
`tencent-project-registry.json` is written via `ConvertTo-Json` + a custom UTF8 writer with no locking. Concurrent `Add-TencentProject.ps1` runs, or one run overlapping a manual edit, can race and corrupt/clobber the registry.

---

## Architectural Gaps (relevant to CONTINUUM specifically)

**R-16 🟡 Two divergent, non-shared memory-context-assembly implementations.**
`MemoryCore/src/core/hooks/auto-recall.ts` (OpenClaw-embedded path) splits recall into a cacheable system-prompt block and a per-turn user-prompt block — a prompt-caching-aware design. The Hermes **v1** Python plugin's `prefetch()` calls the same underlying data (L1/L2/L3) over HTTP but flattens everything into a single string with no stable/dynamic separation. **The launcher's actual day-to-day path (DeepSeek via MemoryProxy) doesn't use either of these directly — MemoryProxy has its own third injection pipeline** (`src/injection/*`) calling MemoryCore's HTTP API independently. Net effect: three different context-assembly code paths exist across the system, with inconsistent prompt-cache awareness.

**R-17 🟡 Only one of three agent paths gets memory at all.**
Per `RUNTIME_FLOW.md` §A: native Claude and native Codex sessions launched by this system receive zero memory injection, zero L0 capture, and zero project/task binding — only the DeepSeek/proxy path does. This is a material gap relative to CONTINUUM's stated goal of shared persistent memory across providers.

**R-18 ⚪ No agent-handoff mechanism exists.**
"Handoff" today is: close one CLI process, start another against the same directory. Continuity depends entirely on whatever got asynchronously captured to L0-L3 memory (which, per R-17, may be nothing). There is no explicit session/task-state package designed for mid-task handoff.

**R-19 ⚪ No MCP support anywhere in the audited codebase.**
Confirmed via repo-wide case-insensitive search under `MemoryCore/`. Tool exposure is host-native (OpenClaw plugin API, or Hermes's bespoke `MemoryProvider` ABC) — building CONTINUUM's Tool/MCP layer means new adapter work, not reuse.

**R-20 ⚪ No native Anthropic LLM client anywhere in MemoryCore.**
`StandaloneLLMRunner` only speaks OpenAI-compatible `/chat/completions` (Vercel AI SDK, `compatibility: "compatible"`). Memory-processing calls (L1/L2/L3 extraction) can reach Claude only via an OpenAI-compatibility shim — there's no direct Anthropic Messages API integration for the memory engine's own internal LLM calls.

**R-21 ⚪ `memory-hub`'s two-service-one-container bundling, with divergent ports between build modes.**
Panel (8123 standalone / 8125 combined) and Knowledge (8421 standalone / 8424 combined) are independently versioned services sharing one container's lifecycle, healthcheck, and restart policy, supervised by a bash script rather than a process manager. No discoverable source of truth for "which port in which mode" besides reading the Dockerfile.

---

## Duplication / Maintainability Debt

**R-22 ⚪ `jarvis`-slug special-casing duplicated independently in 4+ places**: `launch-tencent-claude.ps1` (3×), `Add-TencentProject.ps1`, `test-proxy-workflow.ps1` (3×), `test-tencent-resolution.ps1`, and again in `deploy/global-images/start-all.sh`. No shared library/module — every PowerShell script re-implements alias/slug/container-name derivation from scratch.

**R-23 ⚪ Container-slug derivation regex duplicated verbatim in 4+ files.**

**R-24 ⚪ Port `8125` hardcoded as a literal 9 times in `Add-TencentProject.ps1`**, never read from `PANEL_PORT`/`.env`. The README explicitly documents changing `PANEL_PORT` to resolve conflicts — doing so would silently break project registration with no diagnostic pointing at the mismatch.

**R-25 ⚪ Port `8096` used as a magic number conflating two different concepts** (the *default* project's host port, and the port every proxy container listens on *internally* regardless of host mapping) across 6+ files.

**R-26 ⚪ `Add-TencentProject.ps1` rollback logic re-implemented independently at 4 separate failure points**, not a single rollback-stack/finally pattern — already slightly asymmetric between blocks (some rollbacks revert the registry, some don't).

**R-27 ⚪ `start-all.sh` force-recreates all 3 core containers on every run** (`docker rm -f` unconditional, no "already healthy, skip" fast path) — unlike Step 4 (per-project proxies), which does check first. Not safe to run casually as a "make sure everything's up" command.

**R-28 ⚪ Config YAMLs regenerated/overwritten unconditionally on every start**, with an explicit "don't hand-edit" comment — any manual customization between runs is silently destroyed.

**R-29 ⚪ Registry parsing in `start-all.sh` silently swallows stderr** (`python3 -c ... 2>/dev/null`); a corrupt or malformed registry file yields zero project proxies with only a generic info line, no surfaced error.

**R-30 ⚪ `sqlite-vec` pinned to an alpha release** (`0.1.7-alpha.2`) underpinning the entire standalone vector-store path.

**R-31 ⚪ `stop-all.sh --purge` has no confirmation prompt** — wipes all volumes, the network, `.admin-key`, and both config dirs in one shot.

**R-32 ⚪ Windows-only, PowerShell-only launcher** — no cross-platform path exists; porting to macOS/Linux is a substantial rewrite, not a config change.

**R-33 ⚪ `python3` dependency is implicit and unchecked** in `start-all.sh`'s registry parser and elsewhere — missing `python3` silently produces zero project proxies (compounds R-29) rather than a clear error.

---

## Positive Findings (for balance — not everything is a risk)

- No secret **values** were found logged anywhere in MemoryCore or MemoryProxy (grepped explicitly); masking helpers (`maskMemorySystemUserKeyForLog`) are used consistently in MemoryCore.
- The watchdog/circuit-breaker/auto-recovery mechanics documented in project READMEs for the Hermes v1 plugin were **verified to match the code exactly** — all thresholds are named constants, not scattered magic numbers, and the design rationale (e.g. why the recovery cooldown is shorter than the breaker cooldown) is commented in-line.
- `require_vars()` in `deploy/global-images/_lib.sh` validates all required env vars up front and prints the full missing-list at once — avoids the "fails halfway through, partial state" failure mode this kind of audit usually flags.
- `Add-TencentProject.ps1`'s pre/post-registration git-fingerprint safety check is a genuinely good pattern, not just adequate.
- MemoryCore's `HostAdapter`/`RuntimeContext` abstraction is cleanly host-agnostic by explicit design — confirmed by reading, not just by doc claims.
