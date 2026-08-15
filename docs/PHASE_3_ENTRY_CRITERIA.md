# Phase 3 Entry Criteria

Phase 2 (security & stability hardening) is closed — see `PHASE_2_SECURITY_STABILITY_REPORT.md`. This lists what should be true, or explicitly decided, before Phase 3 (CONTINUUM feature development, per `PHASE_2_RECOMMENDATIONS.md`'s original sequencing) begins.

## Satisfied

- [x] R-1 through R-14 (minus R-6, R-10, R-11 which are contained/out-of-scope, not applicable) closed and live-verified against the real deployment.
- [x] Existing Tencent deployment confirmed fully operational post-hardening: 10/10 containers healthy, all 8 real projects' proxies healthy, memory capture/recall proven working end-to-end.
- [x] Zero unrelated modifications — every pre-existing uncommitted change in the repo (19 files) was left untouched; confirmed via `git status` diff before/after.
- [x] Zero secret exposure — no credential values printed, logged, or committed at any point in Phase 2.
- [x] Nothing committed or pushed (per the phase's rules) — 15 changed files sit ready in the working tree, listed explicitly in the report, not staged.

## Decisions needed from you before Phase 3 starts

1. **Commit the Phase 2 changes?** They're currently uncommitted, sitting alongside your own pre-existing uncommitted work in the same repo. I'd stage the exact 15-file list from `PHASE_2_SECURITY_STABILITY_REPORT.md` §3 explicitly (not `git add -A`) if you want them committed — say the word.
2. **Rotate `MEMORY_CORE_GATEWAY_API_KEY`/admin credentials?** Contained but not eliminated (R-6). Independent of CONTINUUM work, can happen anytime.
3. **Fix the `python3` Windows Store stub issue?** Newly discovered live during Phase 2 — currently breaks `start-all.sh`'s automated project-proxy self-heal/sync. Small, standalone, not part of the original 11-item scope. Recommend doing this before relying on that self-heal path again.
4. **Registration/idempotent-re-registration live test?** Deliberately not run this phase (would create persistent external Tencent metadata with no clean teardown found). If you want it verified live, it needs its own explicit go-ahead given the side effect.
5. **Backport R-8's fix to the 8 existing per-project YAML files?** They still hold literal (not placeholder) upstream keys. Would mean recreating all 8 project proxy containers again — safe based on this phase's precedent (already done once, successfully), but a deliberate action, not something to do silently as part of "just checking."

## Recommended Phase 3 starting point

Per `PHASE_2_RECOMMENDATIONS.md`'s original sequencing (still valid, nothing here changes it): **Provider Adapter foundation** first (generalized provider-routing config + native Anthropic `LLMRunner` for MemoryCore), since Context Manager consolidation and Prompt Cache Intelligence both need a real provider abstraction to target rather than the current Anthropic-impersonation trick. Item 5 from that doc (Health/Recovery consolidation) is a reasonable candidate to pull forward opportunistically alongside it, since Phase 2 touched adjacent code (the launcher's self-heal functions) and the context is fresh — plus it would be the natural place to fix the `python3` issue above as part of the same consolidation rather than as a separate patch.
