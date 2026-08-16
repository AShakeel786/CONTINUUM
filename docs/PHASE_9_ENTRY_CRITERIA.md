# Phase 9 Entry Criteria

Phase 8 (MCP tool layer) is closed. This lists what's satisfied, what it
revealed but deliberately did not build, and the decision before Phase 9.

## Satisfied

- [x] Provider-independent MCP server over stdio (JSON-RPC 2.0, dependency-free).
- [x] Memory tools: `memory_recall`, `memory_search` (read); `memory_capture`,
  `memory_store_atom` (write) — wrapping the `/v3/*` Gateway contract.
- [x] Local-state tools: `session_state`, `session_recent`, `project_state`,
  `project_list` — wrapping SessionManager / ProjectRegistry / session-list.
- [x] Read vs write explicit on every tool; token-conscious, bounded responses.
- [x] No secrets exposed through MCP; MemoryCore unavailability degrades
  clearly (never crashes).
- [x] Project/session isolation (explicit-id scoping; bounded summaries).
- [x] Wired into launch/runtime via shared `resolveDataDir` + MemoryCore
  env-config (no second source of truth); no provider CLI redesign.
- [x] 276 tests + typecheck green; Phases 6 (`8f41186`), 7 (`7423da8`), 7.1
  (`e5ccbb9`) committed; Tencent stack healthy.

## What Phase 8 revealed (documented, not built)

1. **No live non-empty MemoryCore round-trip.** The read/write clients reuse
   the proven `/v3/*` contract, but a live recall+capture against the real
   Gateway (with a seeded identity) was not performed. The combined
   live-verification effort (covering Phase 4 harness → Phase 5 handoff →
   Phase 7 launch → Phase 8 MCP) remains the one cross-phase integration test
   not yet done.
2. **"Create new memory" has no direct primitive.** L1 `atomic/update` upserts
   *by id*; net-new memory flows through L0 `conversation/add` → async L1
   extraction (`memory_capture`). A tool that invents an id on the client would
   cross the wrap-vs-invent line — deliberately not done.
3. **No MCP client-side auth beyond the service token.** The server trusts the
   configured `CONTINUUM_MEMORY_CORE_TOKEN`; there is no per-agent capability
   negotiation in the server (`capabilities: { tools: {} }` only). Fine for the
   "one tool interface" goal; a multi-tenant surface would need more.
4. **`memory_store_atom` is id-required**, so it's a *rewrite* primitive more
   than a *capture* primitive — `memory_capture` is the capture path.

## Decision before Phase 9

**Which direction now?** The original sequencing is functionally complete for
the tool/memory/launcher/session surface. Remaining candidates:

- **Combined live-verification** (seeded MemoryCore identity, one integration
  run covering Phases 4–8) — the highest-value correctness assurance left, and
  the only cross-phase gap that persists.
- **Gemini/Codex/local-model providers** — still no concrete need (deferred
  since Phase 4).
- **Health/Recovery consolidation** — independent, deferred since Phase 1.
- **Autonomous-agent orchestration** — explicitly out of scope for the whole
  line so far; would be a deliberate scope expansion, not a natural next step.

## Recommended Phase 9 starting point

**Combined live-verification effort.** Seed a disposable MemoryCore identity,
run one integration pass through the Phase 4 context harness, Phase 5 handoff,
Phase 7 launcher launch/resume, and Phase 8 MCP read/write tools against real
Gateway data, and close the "implemented-but-not-live-verified" caveat that
Phases 4, 5, 7, and 8 have each independently flagged. Everything else is
either deferred for lack of need (providers) or an explicit scope expansion
(autonomous agents).
