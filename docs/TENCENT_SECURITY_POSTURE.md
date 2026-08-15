# TencentDB Agent Memory — Security Posture (post–Phase 2)

Snapshot as of 2026-08-14, after Phase 2 hardening. Supersedes the security-relevant portions of Phase 1's `RISKS_AND_TECH_DEBT.md` for the 11 findings addressed here; that document remains the record of what was originally found and why.

## Closed this phase

| Finding | Status |
|---|---|
| R-1 — credential-shaped file at risk of accidental commit | **Closed.** Quarantined, gitignored. |
| R-2 — proxy admin routes open by default, no warning | **Closed.** Warned always; fail-closed on genuine non-loopback exposure. |
| R-3 — gateway unauthenticated by default, warn-only | **Closed.** Same fail-closed pattern. |
| R-4 — proxy→core auth broken when gateway auth enabled | **Closed.** Proven live with real containers, before/after. |
| R-5 — memory-hub bound to all interfaces | **Closed.** Loopback-only, matching core/proxy. Confirmed at the OS level, not just Docker's display. |
| R-7 — admin key echoed in plaintext | **Closed.** |
| R-8 — upstream key duplicated across 8 files | **Mitigated for future configs.** Mechanism exists and is proven backward-compatible; the 8 live files weren't retroactively rewritten. |
| R-9 — raw headers stored unredacted in a debug buffer | **Closed.** |
| R-12 — dead self-heal branch | **Closed.** |
| R-13 — unreliable port check on this exact platform | **Closed.** Proven against real occupied/free ports on this machine. |
| R-14 — health check accepted any response | **Closed.** Proven against a real healthy proxy and a simulated unhealthy one. |

## Contained, not eliminated

**R-6 — static default credentials (`local`, `admin`).** These remain the actual configured values in `.env` and the deploy scripts. Rotating them wasn't authorized in this phase ("do not automatically rotate credentials" was an explicit rule). What changed: these weak defaults can no longer be **silently** combined with broader network exposure — R-2/R-3's fail-closed guards mean an operator has to explicitly set `TDAI_GATEWAY_ALLOW_INSECURE_BIND=true` (or the proxy equivalent) to run an unauthenticated, exposed instance. The credential itself is still weak; the blast radius of it being weak is now gated behind a deliberate choice instead of a default.

**Recommendation for whenever you're ready:** rotate `MEMORY_CORE_GATEWAY_API_KEY` / admin credentials to real generated secrets, independent of any CONTINUUM work. This is a config change in `.env`, not a code change, and can happen on its own timeline.

## Explicitly out of scope for Phase 2 (carried forward from Phase 1)

These were documented in `RISKS_AND_TECH_DEBT.md` but were never part of this phase's 11-item scope — listed here so they don't get lost:

- R-10, R-11: dormant `recentInspections.getRecentInspections()` export risk (R-9 addressed the *storage*; the still-unused export itself remains, low risk) and the unconditional permission/sandbox-bypass launch flags.
- R-15 through R-33: registry file-locking, duplicated slug-derivation logic across 4+ scripts, `start-all.sh`'s unconditional force-recreate behavior, config files silently overwritten on every start, the `sqlite-vec` alpha pin, `stop-all.sh --purge` having no confirmation prompt, the Windows-only launcher, and others.
- **Newly observed this phase, not previously documented:** `python3` on this machine resolves to a Windows Store execution-alias stub rather than a real interpreter, silently breaking `start-all.sh` Step 4 (registry-driven project-proxy sync/self-heal) — it exits with code 49 and a Store-install prompt message, which the script's `2>/dev/null` doesn't suppress (that redirects stderr; the message appears to go to stdout) and `set -e` then kills the whole step with no further output. This is the concrete, live manifestation of Phase 1's R-29/R-33 findings. **Recommend fixing this early in Phase 3 or as a standalone hotfix** — it currently means the deploy scripts' own self-healing for missing/newly-registered project proxies doesn't work at all on this machine; project proxy creation currently has to be done manually (as this phase did) or via the PowerShell launcher's `Repair-ProjectProxy`, which doesn't depend on `python3`.

## Verified-safe, worth stating plainly

- No secret **values** were found logged anywhere across memory-core, memory-hub, or proxy, in fresh logs captured after this phase's redeploy.
- All 11 live ports (memory-core, memory-hub ×2, default proxy, 7 project proxies) are confirmed loopback-only at the OS level (`netstat`), not just via Docker's own port-mapping display, which can be misleading on this platform.
- The live deployment's actual current configuration (`MEMORY_CORE_GATEWAY_API_KEY=` empty, all hosts loopback or Docker-standard `0.0.0.0`) was empirically confirmed compatible with every fail-closed guard added this phase — nothing about the real deployment needed to change to keep working.
