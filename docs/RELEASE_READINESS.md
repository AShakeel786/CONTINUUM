# RELEASE_READINESS — Public GitHub Beta Assessment

**Date:** 2026-08-16
**State:** Phase 19 (release candidate)

## Verdict

**Ready for a public GitHub beta**, with clearly-scoped caveats. The core loop
(setup → project → launch → session → resume → handoff → doctor) is proven on a
clean-room install, the full test suite passes (52 files / 363 tests), and
typecheck/build are clean.

## What is solid

- **Three real providers** — Claude Code (native), DeepSeek (Tencent proxy), Codex (native).
- **Onboarding** — `setup`/`providers`/`auth` with OS-native credential backends, references-only config.
- **Durable session state + handoff** — atomic writes, corruption recovery, optimistic concurrency;
  Claude/DeepSeek/Codex handoff in all directions; receiving agent does not re-audit.
- **Native-session continuity** — resume the provider's own CLI session (Claude `--resume`/`--session-id`,
  Codex `resume`), with safe fallback to a resume brief.
- **MCP** — provider-independent stdio server + idempotent auto-connect + functional initialize health.
- **Health/recovery** — `doctor` + `doctor --repair` (MemoryCore outage behind a healthy proxy).

## Known limitations to state in the beta notes

1. **The Tencent memory stack is optional but the health layer assumes it.** A beta user
   without Docker/Tencent will see `doctor` report the stack "down" (degraded, not fatal —
   CONTINUUM runs with local session context only). Documented; the Tencent repo + Docker
   compose are a separate, optional component.
2. **MCP auto-register is consent-gated and not applied automatically on first run** — the
   user must accept the one-time consent (or run `mcp-setup`). By design.
3. **`private: true` in package.json** — intentional: the beta is clone-and-build, not npm
   registry distribution; prevents accidental publish.
4. **No `engines` field** — the required Node major is not yet pinned (uses `AbortSignal.timeout`,
   top-level await, `import.meta.url`; effectively Node ≥18, untested below that).
5. **Windows/Linux credential backends** are implemented but only macOS is live-verified on this machine.

## Beta scope recommendation

- Target: developers comfortable with `npm ci && npm run build` + an optional Docker memory stack.
- Call it a **beta**, not stable: the macOS path is the most-tested; treat Windows/Linux as "best-effort".
- Ship with the README quick-start (updated this phase) + this release note.

## What is NOT ready (and should not be promised)

- A fourth provider (Gemini/local models), a UI, or npm-registry distribution.
- Precise "stale registration" re-registration in `doctor --repair` (Phase 19 deferral — missing
  registration is repaired; an old-path entry is detected but not yet re-registered).

## Go/no-go

**Go** for a public GitHub beta with the caveats above.
