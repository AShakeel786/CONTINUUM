# Phase 14 — Health & Recovery Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** `src/health/*` + CLI wiring (`doctor`, `launch`) — detect & auto-repair the
MemoryCore-behind-a-"healthy"-proxy outage that surfaces as a misleading
`401 / Please run /login`.

## Confirmed live failure (reproduced)

| Signal | Expected | Observed |
|---|---|---|
| `tdai-memory-core` stopped | — | `exited` |
| proxy `/health` | should *not* mask outage | still `200` |
| proxy auth path (probe key) | real cause visible | `{"error":"Authentication failed: auth service error: fetch failed"}` HTTP 401 |
| MemoryCore `/v3/meta/auth/verify` | reachable | connection refused (HTTP 000) |

## What was already implemented (Phase 14 partial, present at resume)

- `src/health/types.ts` — check/report/repair/outcome types + injectable `HealthRuntime`.
- `src/health/checks.ts` — docker daemon, container states, gateway `/health` probes,
  provider/credential/session/stale-process checks.
- `src/health/repair.ts` — docker-desktop launch, `docker start` (stopped), canonical
  `start-tencent.sh` recreate (missing, pinned-image-guarded), provider/credential
  directives, stale-process kill; cooldown + circuit breaker.
- `src/health/state.ts` — atomic cooldown/breaker persistence.
- `src/health/adapters.ts` — live runtime + session-store audit + stale-process scan.
- `src/health/preflight.ts` — warn-never-block launcher preflight.
- CLI wiring in `src/cli/commands/doctor.ts` and `src/cli/commands/launch.ts`.

## What was finished this session

1. **Functional dependency probe** `gateway:memory-core-auth` — POSTs a non-secret
   invalid key to MemoryCore `/v3/meta/auth/verify`; `down` when unreachable → repair
   `container-restart` (memory-core).
2. **Functional proxy/auth probe** `proxy:auth` — POSTs the same invalid key through the
   real proxy auth path and classifies the rejection:
   - `401 + "auth service …"` → **MemoryCore dependency unavailable** (repair memory-core)
   - `401 + "invalid user_key"` → auth working (ok) — distinguishes a genuine bad key
   - `status 0` → proxy unreachable (repair proxy)
3. **Wait-for-healthy** after `docker start` / `docker restart` — recovery is only
   `repaired` once `docker inspect` reports `healthy`.
4. **`container-restart` repair target** for a running-but-broken auth dependency.
5. **Subject-keyed cooldown/breaker** (`container:<name>`) so a single MemoryCore outage
   observed by 4 checks triggers **one** recovery action per pass, not 4 restarts.
6. **Preflight warnings** for the two new functional checks.
7. **Proxy-auth probe timeout** (8s) > proxy's own `auth.timeoutMs` (5s), so a hanging
   MemoryCore is surfaced as "auth service timeout", not a premature "proxy down".

### Three-way auth-failure distinction (requirement)

| Failure | Check | Signal |
|---|---|---|
| native provider auth | `provider:<id>` | CLI not installed/authenticated / no API key |
| proxy auth (bad key) | `proxy:auth` → `ok` (probe key rejected as `invalid user_key`) | proxy *can* verify keys; user key is wrong |
| MemoryCore dependency | `gateway:memory-core-auth` + `proxy:auth` | auth/verify unreachable / `auth service …` |

## MemoryCore-outage recovery result (live)

`docker stop tdai-memory-core` → `continuum doctor --repair`:

- Detected: `container:tdai-memory-core down`, `gateway:memory-core down`,
  `gateway:memory-core-auth down`, `proxy:auth down` (auth backend unavailable) —
  while `gateway:proxy` reported **ok**.
- Repaired: `[repaired] container:tdai-memory-core (container-start): started tdai-memory-core (healthy)`
  (single action; the other three same-subject checks were cooldown-skipped).
- Recheck: all `ok`, overall `healthy`, exit code `0`.

## Functional proxy/auth health result (live)

- Healthy stack: `proxy:auth = auth verification working (probe key correctly rejected, HTTP 401)`;
  `gateway:memory-core-auth = auth/verify reachable (HTTP 200)`.
- MemoryCore down: `proxy:auth = proxy auth backend (MemoryCore) unavailable — Claude Code
  shows 401/Please run /login`; `gateway:memory-core-auth = auth/verify unreachable`.

## Tests

- `npm test` → **44 files / 300 tests passed** (health suite: 19 tests).
- `npm run typecheck` → clean. `npm run build` → clean.
- New coverage: healthy-but-degraded proxy detection, invalid-user_key vs outage
  distinction, container-restart recovery, proxy-unreachable path, preflight warning.

## Tencent health

- **No files changed** in `TencentDB-Agent-Memory`. The repo's 822 `M` entries are a
  pre-existing line-ending normalization (insertions == deletions), not content edits.
- Runtime-only operations: `docker stop/start`, read-only `curl` probes, and `docker inspect`.

## Remaining risks

1. **Proxy auth backend is MemoryCore-specific.** The `proxy:auth` classifier keys on the
   proxy's `Authentication failed: auth service …` wording (verified against the pinned
   `:phase13` proxy image). A future proxy build that changes that wording would need the
   classifier updated.
2. **`docker restart` on a running memory-core is disruptive** (brief auth outage). It is
   only triggered when the functional auth probe fails while the container is still
   `healthy` — an uncommon state; normal "stopped" recovery uses `docker start`.
3. **`proxy:auth` adds ~one HTTP round-trip to every launch preflight** (milliseconds when
   healthy, bounded by 8s when degraded). Preflight remains warn-never-block.
4. **Provider/auth health is empty until CONTINUUM has providers configured** (this machine
   currently reports "No providers configured"), so the native-provider branch is
   unit-tested but not yet exercised live end-to-end.
