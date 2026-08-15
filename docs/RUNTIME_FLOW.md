# Runtime Flow — Existing Tencent System (verified trace)

This traces the **actual, currently-working** flow from launch to model response, as read from source. It is split into (A) the Windows launcher path — what a human triggers day to day — and (B) the Docker stack path — what `deploy/global-images/start-all.sh` brings up underneath it. Line numbers refer to the audited snapshot and may drift; re-verify before relying on them for an edit.

---

## A. Launcher → Agent → Proxy → Model (per-session flow)

```text
 1. Desktop shortcut (.lnk, NOT in repo)
    → powershell.exe -File windows\launch-tencent-claude.ps1

 2. launch-tencent-claude.ps1 starts
    - sets window title, resolves script/repo root paths
    - wraps steps 3-18 in one try/catch (any failure → print diagnostics,
      Read-Host "Press Enter to close", exit 1)

 3. [optional] -DebugLaunch diagnostics block

 4. Preflight: Test-ProxyHealth against default proxy :8096
    - POST /claude-code/default/v1/messages with a dummy ping
    - ANY http response (even 401/500) counts as "healthy"
    - unhealthy → Start-TencentStack:
        a. verify Docker available (die if not)
        b. ensure docker network `tdai-memory-stack` exists
        c. verify/start 3 core containers: tdai-memory-core,
           tdai-memory-hub, tdai-proxy (die if a core container
           is entirely missing — no auto-create for core)
        d. Repair-ProjectProxy for every registry project
           (self-heals per-project proxy containers)
        e. poll default-proxy health up to 60s

 5. Load windows\tencent-project-registry.json (die if missing)
    build alias map + name map (first-registered-wins on collisions)

 6. Resolve project, in priority order:
    a. CLI positional arg matched against alias/name/literal path
    b. -TaskName matched against name map
    c. auto-detect from CWD (prefix match against each project's `path`)
    d. interactive numbered menu (registry projects + [0] Neutral);
       free-text input is checked for a natural-language
       "register/onboard <path>" instruction and can trigger
       Add-TencentProject.ps1 mid-launch

 7. Apply resolved project: TaskName, ProjectPath, SettingsPath,
    ProxyBase = http://127.0.0.1:<project.proxyPort>
    [KNOWN BUG: a per-project proxy self-heal branch here gates on
     $AgentChoice, which is not assigned until step 9 — this branch
     is dead code as currently ordered; see RISKS_AND_TECH_DEBT.md]

 8. Resolve working directory (die if ProjectPath doesn't exist on
    disk; else default to the "neutral" Documents folder)

 9. Agent selection: -Agent flag or interactive menu
    → deepseek (default) | claude | codex

10. Environment sanitization: clear a large pattern-list of inherited
    env vars (ANTHROPIC_*, CLAUDE_*, OPENAI_*, DEEPSEEK_*, JARVIS_*, …)
    to prevent leakage from a prior session/tool in the same shell.
    Prepend .local\bin to PATH.

11. Per-agent environment setup (see table below)

12. Verify the resolved executable exists on disk (die if not)

13. Create Claude config dir if missing (.claude-tencent /
    .claude-anthropic — Codex has no equivalent, uses its own
    pre-existing ~/.codex state untouched by this launcher)

14. Push-Location into the working directory; re-read Get-Location
    and die if it doesn't match exactly (defensive CWD check)

15. Print diagnostic summary (CWD, agent, project, proxy, model, RTK)

16. Launch (BLOCKING): & $ExePath <args>
    - deepseek: claude.exe --settings <path>
                --permission-mode bypassPermissions
    - claude:   claude.exe --permission-mode bypassPermissions
    - codex:    codex.exe  --dangerously-bypass-approvals-and-sandbox
    ALL THREE bypass permission/sandbox prompts unconditionally.

17. [inside the launched CLI, deepseek path]
    Every outbound Anthropic-protocol call hits
    ANTHROPIC_BASE_URL = http://127.0.0.1:<projectPort>/claude-code/default
    → MemoryProxy container for this project:
        auth (x-tdai-user-key check against MemoryCore)
        → sessionInit (first-turn team/agent/task picker, if enabled)
        → injection (HTTP calls to MemoryCore: skill search, knowledge,
          L1-L3 memory → spliced into system prompt / messages)
        → rateLimit (Redis, per spaceId × model)
        → forward (plain fetch() passthrough to the real upstream LLM,
          e.g. DeepSeek's OpenAI-compatible endpoint; SSE preserved)
        → extract (async, non-blocking write-back of the turn to
          MemoryCore — this is where L0 capture happens for this path)
        → report (ClickHouse/Langfuse/Opik/billing telemetry)
    Response streamed back through the proxy, through Claude Code,
    to the terminal.

    [inside the launched CLI, claude/codex paths]
    No proxy in the loop at all — native Anthropic/OpenAI endpoints
    are called directly. No project/task binding, no memory injection,
    no L0 capture for these two paths via this launcher.

18. On CLI exit: Pop-Location (success) or full error diagnostics +
    Pop-Location + Read-Host + exit 1 (failure, from the catch block)
```

### Two structurally different "runs" depending on agent choice

| | `deepseek` | `claude` (native) | `codex` (native) |
|---|---|---|---|
| Routed through MemoryProxy | ✅ | ❌ | ❌ |
| Memory context injected | ✅ (via proxy → MemoryCore) | ❌ | ❌ |
| L0 conversation captured | ✅ (async, proxy `extract` stage) | ❌ | ❌ |
| Project/task header binding | ✅ (`x-team-id`/`x-agent-id`/`x-task-id`) | ❌ | ❌ |
| Config isolation | `.claude-tencent` | `.claude-anthropic` | `~/.codex` (unmanaged) |
| Sandbox/permission bypass | ✅ | ✅ | ✅ |

This is a verified, significant fact for CONTINUUM design: **only the DeepSeek/proxy path currently gets any memory, project, or task context at all.** Native Claude and Codex sessions launched by this system are memory-blind.

---

## B. Docker Stack Bring-Up (`deploy/global-images/start-all.sh`)

This is what step 4 above (`Start-TencentStack`) triggers when the default proxy is unhealthy, and what an operator runs directly for the "standard install."

```text
1. load .env (die if missing)
2. require_vars: validate all 16 required vars across memory-core,
   memory-hub, proxy up front — fail fast with a full missing-list,
   not halfway through
3. Step 1/3 — memory-core:
     ensure docker network `tdai-memory-stack`
     rm -f any existing tdai-memory-core container (unconditional —
       every run is a hard recreate, no "already healthy, skip")
     regenerate .memory-core-config/tdai-gateway.yaml (overwrites any
       manual edits, by design — comment: "don't edit by hand")
     docker run -d, bind 127.0.0.1:${MEMORY_CORE_PORT}:8420
     wait_healthy (90s) — dumps last 30 log lines and dies on failure
     generate random admin key → POST /v3/internal/meta/user/init-admin
       → persist to .admin-key → verify via /v3/meta/auth/verify
4. Step 2/3 — memory-hub (combined Panel+Knowledge image):
     warn (non-blocking) if memory-core isn't running
     auto-detect LAN IP for public-URL display unless set explicitly
     docker run -d, publish BOTH ${PANEL_PORT}:8125 and
       ${KNOWLEDGE_PORT}:8424 — NOT loopback-scoped (all interfaces)
     REMOTE_INSTANCE_URL=http://memory-core:8420 (docker network alias)
     wait_healthy (120s) — container's own HEALTHCHECK curls both
       ports' /health
5. Step 3/3 — proxy:
     PROXY_FULL_STACK defaults ON here (auth+sessionInit+injection
       all enabled) — different default than running start-proxy.sh
       standalone
     warn (non-blocking) if memory-core/memory-hub aren't running
     regenerate .proxy-config/config.yaml (overwrites manual edits)
     docker run -d, bind 127.0.0.1:${PROXY_PORT}:8096
     wait_healthy (90s)
6. print_endpoints — address table for Panel/Knowledge/Core/Proxy
7. Step 4/4 — registry-backed per-project proxies (only if
   windows/tencent-project-registry.json exists):
     parse registry via an inline python3 one-liner (stderr silenced;
       a corrupt registry silently yields zero project proxies)
     for each project (skipping slug == "jarvis", hardcoded):
       if container missing AND a matching .proxy-config/config-<slug>.yaml
         exists → create + wait_healthy (60s)
       if missing but no config file → warn and skip (non-fatal)
       if exists but stopped → start it
       if already running → no-op (this step alone is idempotent;
         steps 3-5 above are not)
8. Print Claude Code usage instructions, INCLUDING THE ADMIN KEY IN
   PLAINTEXT (inconsistent with start-memory-core.sh, which masks the
   same key deliberately a few steps earlier)
```

### Service dependency graph (verified)

```text
memory-core (:8420, loopback)
   │  no external deps — always starts first
   │
   ├──▶ memory-hub / knowledge (:8424, all interfaces)
   │        │  calls memory-core for embeddings/RAG
   │        │  LLM_MODE=proxy → Knowledge doesn't call an LLM directly;
   │        │  it waits on Panel to push an llm_binding to it
   │        │
   │        └──▶ memory-hub / panel (:8125, all interfaces)
   │                 boot-checks Knowledge's /v3/internal/llm-binding/status
   │                 (must be healthy first — enforced inside the
   │                  container's own start-combined.sh, not by
   │                  start-all.sh's top-level ordering)
   │
   └──▶ proxy (:8096, loopback)
            tdai.endpoint = memory-core:8420
            sessionInit / knowledge injector implicitly depend on
            memory-hub being reachable, but proxy only does a
            one-time non-blocking warn if it isn't — no runtime
            retry if a request races an unready memory-hub

per-project proxies (:8097-8103, loopback)
   depend on: docker network already existing, a pre-generated
   config-<slug>.yaml (produced externally by Add-TencentProject.ps1,
   not by anything in deploy/)
```

---

## C. Where CONTINUUM's Later Phases Will Need to Hook In

- **Agent Router**: today, "routing" = a human picking a number from a PowerShell menu, then a hardcoded 3-way `switch` statement. No programmatic router exists.
- **Agent Handoff**: does not exist at all. "Handoff" today means closing one CLI process and starting another against the same working directory; the only continuity is whatever L0-L3 memory the DeepSeek/proxy path happened to capture asynchronously (and native Claude/Codex sessions capture nothing).
- **Prompt Cache Intelligence**: the stable/dynamic split already exists in `MemoryCore/src/core/hooks/auto-recall.ts`, but only reaches the OpenClaw-embedded integration path, not the proxy/Hermes-v1 path this launcher actually uses day to day.
- **Token Manager**: `applyRecallBudget` in `auto-recall.ts` (char/count budget, UTF-8-safe truncation) is the closest existing primitive; MemoryProxy's rate-limiting is per-spaceId×model TPM/QPM via Redis, a separate concern.
- **Provider Adapters**: MemoryProxy's `upstream.agents[]` config table + `src/agent-adapters/` interface is the best existing seam; it currently covers Claude Code and CodeBuddy CLI shapes only, and DeepSeek/OpenAI-compatible upstreams only (no native Anthropic LLM calls from MemoryCore itself, no Gemini, no local models anywhere in the system).
