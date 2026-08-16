# Third-Party License & Code Provenance Audit

**Date:** 2026-08-16
**Scope:** CONTINUUM v0.1.0-beta.1 (pre-license)
**Method:** git history + current tree inspected; authoritative upstream (local clone of
`TencentDB-Agent-Memory` at `~/Developer/Ai-tools/TencentDB-Agent-Memory`) read for license
and for code-structure comparison. No legal certainty is claimed.

## 1. Provenance determination

The CONTINUUM repo's first commit is `0b57a95` ("Phase 3 (provider adapter foundation) …").
Phases 1–2 were an audit of a *separate* repo and produced only `docs/`, not code. Every
subsequent phase (3–21) added **newly-written TypeScript** to CONTINUUM. A search of the full
history found no "vendor/copy/import/port/adapt" commit and no file added from an external repo.

Result by category:

| Category | Components | Evidence |
|---|---|---|
| **A — copied source** | *none found* | no vendored files; no cross-repo `import`s; no matching identifiers |
| **B — modified/adapted source** | *none found* | same as above |
| **C — independently reimplemented ideas/patterns** | context stable/dynamic split; circuit-breaker/cooldown; `/v3` wire clients; cache-directive emission; MCP JSON-RPC framing; atomic-file | written fresh in TS; docs repeatedly state "read but not copied", "pattern reused, not literal shared code", "Constructed, not copied" |
| **D — npm dependencies** | `js-tiktoken` (runtime); `typescript`, `@types/node`, `vitest` + transitives (dev) | `package.json` / `package-lock.json` |
| **E — uncertain provenance** | *none* | all traced |

## 2. Original licenses (for the one relevant upstream)

### TencentDB-Agent-Memory (MemoryCore / MemoryProxy / Hermes)
- **Relationship:** the memory/context **infrastructure** CONTINUUM calls at runtime, and the
  source of several *ideas/patterns* CONTINUUM reimplemented. No source was copied into CONTINUUM.
- **Upstream license:** **MIT** (file `LICENSE` — "TencentDB Agent Memory is licensed under the MIT.
  Copyright (C) 2026 Tencent. All rights reserved."). Verified by reading the local clone's `LICENSE`.
- **Copyright notice:** "Copyright (C) 2026 Tencent."
- **NOTICE file:** none present.
- **Verdict:** permissive; **compatible with both MIT and Apache-2.0**.

### Other repos referenced in docs (`squeez`, `repomix`, `token-optimizer`, `gstack`, `RTK`, …)
- These appear as *reference* context in earlier reports, not as code sources. No file in
  CONTINUUM derives from them. **No obligation.**

## 3. Compatibility / compliance matrix

| CONTINUUM file/component | Upstream | Relationship | Upstream license | Attribution required | NOTICE | Modified-file notice | Copyleft? | Compatible MIT/Apache-2.0 |
|---|---|---|---|---|---|---|---|---|
| `src/context/*` (stable/dynamic split) | MemoryCore `auto-recall.ts` | C (reimplemented pattern) | MIT | courtesy only | no | no | no | yes / yes |
| `src/token/tokenizer.ts` | `js-tiktoken` + MemoryCore usage | D + C | MIT | dependency | no | no | no | yes / yes |
| `src/health/*` (circuit-breaker/cooldown) | Hermes watchdog *concept* (generic) | C | n/a (generic pattern) | none | no | no | no | yes / yes |
| `src/context/memorycore-client.ts`, `-write.ts` | MemoryCore `/v3/*` API | C (wire contract reimplemented) | MIT (upstream) | courtesy only | no | no | no | yes / yes |
| `src/cache/directives.ts` | Anthropic Messages API | C (public API contract) | n/a | none | no | no | no | yes / yes |
| `src/mcp/*` | MCP spec (JSON-RPC framing) | C (public spec reimplemented) | n/a | none | no | no | no | yes / yes |
| `src/session/atomic-file.ts` | generic pattern | C | n/a | none | no | no | no | yes / yes |
| `js-tiktoken@1.0.21` | npm | D | MIT | via dependency | no | no | no | yes / yes |
| `typescript@5.9.3` (dev) | npm | D | Apache-2.0 | via dependency (not distributed) | n/a (dev-only) | no | no | yes / yes |
| `vitest@3.2.7` + transitives (dev) | npm | D | MIT / Apache-2.0 / ISC / BSD-3-Clause | via dependency | n/a | no | no | yes / yes |

No GPL/LGPL/AGPL/MPL, no BUSL/source-available, no "no-license"/UNKNOWN upstream or dependency.

## 4. Dependencies (audited separately)

- **Runtime:** `js-tiktoken` (MIT).
- **Dev:** `typescript` (Apache-2.0), `@types/node` (MIT), `vitest` + transitives (MIT, Apache-2.0,
  ISC, BSD-3-Clause). All permissive; none are distributed as part of CONTINUUM's source (dev-only).
- **No** copyleft, source-available, or unknown-license dependency.

## 5. Copyright / notice preservation

- No copyright/license headers were found in CONTINUUM source (git grep returned none), so **no
  headers were removed during migration** — there was nothing to preserve.
- Required artifacts: **none are legally required** (no copied source).
- Recommended (courtesy, not obligation): a `THIRD_PARTY_NOTICES` note acknowledging
  TencentDB-Agent-Memory (MIT) as the memory-infrastructure upstream and the source of several
  reimplemented patterns, and the `js-tiktoken` (MIT) dependency.

## 6. Release decision (see LICENSE_COMPATIBILITY_MATRIX.md)

**Verdict: LICENSE_CLEAR.**

No copied/adapted third-party source exists in CONTINUUM; the single relevant upstream is MIT;
all dependencies are permissive. Both MIT and Apache-2.0 safely cover the distribution.
Recommendation: **MIT** (simplest, and matches the one relevant upstream's own license).

---

## Addendum — token-efficiency research references (no source incorporated)

During the token-efficiency phases, the following open-source projects were studied as
*references only*. Their source was **not** incorporated into CONTINUUM; the relevant ideas were
independently reimplemented in TypeScript. They are listed for acknowledgement completeness and
impose **no license obligations** on CONTINUUM (MIT).

| Project | License | Relationship |
|---|---|---|
| rtk-ai/rtk | Apache-2.0 | independently reimplemented concept (tool-output compression) |
| Aider-AI/aider | Apache-2.0 | independently reimplemented concept (repo map) |
| headroomlabs-ai/headroom | Apache-2.0 | research/reference only |
| zilliztech/GPTCache | MIT | research/reference only (semantic caching evaluated, rejected) |
| open-compress/claw-compactor | MIT | research/reference only |
| microsoft/LLMLingua | MIT | research/reference only (lossy compression evaluated, rejected) |
| zilliztech/claude-context | MIT | research/reference only |
| ojuschugh1/sqz | Elastic License 2.0 | research/idea reference only — **no source incorporated** |
| Opencode-DCP/opencode-dynamic-context-pruning | AGPL-3.0 | research/idea reference only — **no source incorporated** |

The two restrictive-licensed projects (`sqz` ELv2, `opencode-dcp` AGPL-3.0) were read for ideas
only; no code or derived structure was taken, so neither imposes copyleft or source-available
obligations on CONTINUUM's MIT distribution.
