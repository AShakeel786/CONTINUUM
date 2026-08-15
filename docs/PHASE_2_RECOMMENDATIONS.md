# Phase 2 Recommendations

Phase 1 was audit-only; nothing was built or fixed. This document proposes what Phase 2 should actually do, based on what the audit found. **This is a recommendation, not an approved plan** — needs your go-ahead before any of it starts, per the Phase 1 rules.

## Recommended Phase 2 scope, in dependency order

### 0. Security remediation punch-list (independent of CONTINUUM design — can happen anytime, arguably before anything else)

These are live risks in the *existing* Tencent deployment, not CONTINUUM features. Doing this doesn't require any CONTINUUM code to exist yet:

- R-1: delete or gitignore the credential-shaped stray file in `TencentDB-Agent-Memory\backups\2026-08-09_bypass-all-agents\`.
- R-2/R-3/R-6: require a non-default admin/gateway API key before any container binds beyond `127.0.0.1`.
- R-4: fix the `MemoryProxy/src/auth.ts` Bearer-header bug that currently breaks the "secure" auth path — this is the one item here that's actual code, not config, and should get its own small, reviewed change.
- R-5: make memory-hub's bind-scope consistent with memory-core/proxy (loopback by default, explicit opt-in to wider exposure).
- R-7: stop printing the admin key unmasked in `start-all.sh`'s final output.
- R-8: stop duplicating the plaintext upstream API key into every per-project YAML; centralize it.
- R-9: remove or redact the dormant `recentInspections` raw-header buffer in `MemoryProxy/src/identity.ts`.

*I'd suggest doing this as its own small, reviewed pass — it touches production-adjacent files in your working Tencent deployment, so it should follow the same staged-release discipline you've used before (see your `feedback_prod_migration_safety_albaik` memory: deterministic changes, no silent scope creep, verify before/after).*

### 1. Provider Adapter foundation

Build the generalized provider-routing config (data-driven, replacing the 3-way hardcoded switch) and a native Anthropic `LLMRunner` for MemoryCore (currently OpenAI-compatible-only). This unblocks everything else — Context Manager consolidation and Prompt Cache Intelligence both need a real provider abstraction to target, not the current impersonation trick.

### 2. Context Manager consolidation

Pick one context-assembly implementation (recommend: the `auto-recall.ts` stable/dynamic design — it's the most mature of the three found) and make it the single path every provider integration calls through. This is what actually closes the "native Claude/Codex sessions get no memory" gap (R-17), which is arguably the biggest functional gap found relative to CONTINUUM's stated goals.

### 3. MCP wrapper around MemoryCore's Gateway API

Independent of 1/2 — can run in parallel. Wraps existing, well-typed skill/knowledge/memory endpoints; preserves the credential-injection-at-boundary pattern from MemoryProxy's bridge routes.

### 4. Agent/task session-state layer + Agent Handoff prototype

Depends on having *something* in Context Manager to summarize. Start with the session-state schema (active provider, working directory, open task, conversation cursor) since that's the harder design problem; handoff itself can be a thin consumer of it once it exists.

### 5. Health/Recovery consolidation

Independent of the above — can be pulled forward opportunistically. Port the Hermes v1 watchdog/circuit-breaker design (the best-engineered self-healing code found in the audit) into one shared implementation, and along the way fix the confirmed dead-code gap (R-12: per-project proxy self-heal branch that can never fire due to variable-ordering).

### 6. Project Registry generalization + cross-platform launcher

Lower urgency — the current Windows-only launcher works for your actual 8 projects today. Worth doing once the provider/context layers above are stable enough that the launcher has something new to route to.

## Explicitly NOT in Phase 2

- Full multi-provider parity (Gemini, local models) — sequence after the provider-adapter *foundation* is proven with Claude + DeepSeek, not before.
- Production hardening of the Docker orchestration itself (moving off raw `docker run` to real compose/orchestration) — valuable but not blocking for the CONTINUUM-specific goals; can be its own later workstream.
- Any UI/Panel changes — MemoryPanel wasn't found to need CONTINUUM-driven changes in this audit.
- Rewriting or touching any currently-working Tencent code as a side effect of Phase 2 work, beyond the narrowly-scoped auth-bug fix in item 0.

## Before Phase 2 starts

- Confirm the security punch-list (item 0) is wanted, and whether it should run before or in parallel with the CONTINUUM-specific items — it touches your live TencentDB-Agent-Memory deployment, not just the new CONTINUUM repo.
- Confirm which provider to prioritize after Claude/DeepSeek (Gemini vs. local models) based on what you actually need next, rather than defaulting to the brief's listed order.
- Decide where CONTINUUM's own orchestration will live relative to the existing `deploy/global-images/` scripts — as a replacement, or side-by-side during a transition period. This audit found the existing scripts are actively used for your 8 real projects, so a hard cutover has real blast radius.
