# Phase 4 — Token Manager & Prompt Cache Intelligence Report

Companion to `PHASE_4_CONTEXT_ARCHITECTURE.md`. Implementation detail and — most importantly — exactly what's real-provider-verified versus estimated, per the brief's repeated "do not fake" requirements.

---

## 1. Token Manager (`src/token/`)

### Tokenizer — real BPE, always labeled

`src/token/tokenizer.ts` uses `js-tiktoken`'s `o200k_base` encoding — **the same library and encoding `MemoryCore` already uses internally** (`MemoryCore/src/offload-client/token-estimator.ts`, `src/offload_server/compact/compressor.ts` — found while checking whether a tokenizer dependency already existed before adding one to CONTINUUM). This is a real byte-pair-encoding tokenizer, not a chars/4 heuristic — but it is still labeled `"tiktoken-estimate"`, never `"exact"`, for every provider, including Claude: neither Anthropic nor DeepSeek publish a tokenizer confirmed byte-identical to OpenAI's o200k_base encoding. The only count ever labeled `"provider-reported"` is one built from a real API response's `usage` block, post-call (`fromProviderUsage()`) — that distinction is carried on every `TokenCount` value, not just documented in a comment (`addTokenCounts()` even degrades a sum to `"tiktoken-estimate"` if either addend isn't exact).

### Budgeting and deterministic trimming (`src/token/budget.ts`)

- **The `instructions` class is never touched — not "trimmed last," genuinely exempt.** If `instructions` content alone exceeds the available budget, `allocateBudget` returns the envelope **completely unchanged** and sets `criticalContentOverBudget: true` rather than guessing at a "least-bad" cut. This was a deliberate rejection of "truncate everything proportionally" as an option: the brief says "never silently truncate critical instructions," and the only way to honor that literally is to not truncate them at all, ever, even under pressure — a caller that hits this flag has a real problem (instructions too large for the model) that budgeting can't paper over.
- Everything else trims by each block's own `priority` (lower = kept longer), with `recalled-memory` defaulting to the highest (most disposable) priority — matching `auto-recall.ts`'s own framing of L1 recall as reference-only ("仅作为参考"), not permanent instruction.
- Trimming prefers **truncation over dropping** when a block partially fits: `truncateToTokenBudget` binary-searches a code-point-safe prefix (never cutting inside a UTF-16 surrogate pair) whose token count fits the remaining budget — the same safety concern `auto-recall.ts`'s `truncateRecallLine` documents, reimplemented for token counts instead of character counts (CONTINUUM is a separate package from MemoryCore; the *pattern* was reused, not literal shared code).
- Every trim (`TrimEvent`) carries `blockId`, `class`, `action` (`"truncated"|"dropped"`), `tokensBefore`/`tokensAfter`, and a human-readable `reason` — the brief's "identify what was dropped and why," satisfied per-block, not as one summary line.
- Final ordering after trimming re-runs `orderBlocks` — trim-candidate order (by priority) and display order (by class) are different orderings, and only the latter is what a rendered prompt should show.

## 2. Prompt Cache Intelligence (`src/cache/`)

### What's real vs. constructed vs. inferred — stated plainly, per module

| Module | Nature |
|---|---|
| `directives.ts` (Claude cache_control emission) | **Constructed, not copied.** A repo-wide search found MemoryProxy only ever *passes through* a `cache_control` marker the Claude Code CLI itself already attached (`MemoryProxy/src/injection/adapters/anthropic.ts`) — nothing in the codebase builds one. `{"type": "ephemeral"}` is Anthropic's own documented, public API contract for this marker; this is the one genuinely new capability the brief asked for ("What's missing 🆕 is emitting provider-specific cache-control metadata," per `TENCENT_MIGRATION_MAP.md`). |
| `telemetry.ts` (usage-block parsing) | **Verified against real, in-production code**, not guessed. Field names and the Anthropic-vs-OpenAI branching logic match `MemoryProxy/src/credit-reporter.ts`'s `computeCreditDelta` exactly — real billing code already parsing these fields from live Anthropic and DeepSeek responses today. |
| `invalidation.ts` (prefix-stability hashing) | **New**, no existing precedent — a straightforward SHA-256 over the deterministically-ordered stable section. |

### Claude / Anthropic explicit caching

`computeCacheDirectives()` emits exactly **one** `cache_control: {type: "ephemeral"}` marker, attached to the *last* block in the deterministically-ordered stable section — matching Anthropic's own documented behavior that a single breakpoint caches everything up to and including it, not one breakpoint per block (which Anthropic's API caps and which would be redundant anyway). Only emitted when `capabilities.promptCache === "anthropic-explicit"` — a capability check, not a Claude-specific `if`.

**Not implemented, stated plainly rather than silently absent:** TTL selection (Anthropic supports 5-minute and 1-hour cache lifetimes; this phase always uses the default, doesn't choose between them) and multi-breakpoint strategies (e.g. a second breakpoint partway through a very large stable section). No evidence from the current system suggested either was needed for a first working version, and adding them without a concrete driving case would have been exactly the "over-engineering" the brief warns against.

### DeepSeek caching — verified capability, not assumed

DeepSeek's `promptCache: "openai-automatic"` (set in Phase 3) means: caching is server-side and automatic, **there is no client-controllable directive to emit** — `computeCacheDirectives()` correctly returns `[]` for it, the same as any `"none"` provider would get. What *is* real and implemented: **telemetry parsing**, because `credit-reporter.ts` proves DeepSeek's responses really do carry usable cache fields (`cache_read_tokens`, or the alternate `prompt_tokens_details.cached_tokens` naming) — this phase's `telemetry.ts` parses exactly those, verified field-for-field against that existing code.

### Cache telemetry — the diagnostics, and where each number comes from

```text
inputTokens          -- provider-reported (protocol-specific reconstruction, see below)
cachedTokens          -- provider-reported (cache_read_input_tokens / cache_read_tokens / prompt_tokens_details.cached_tokens)
freshTokens            -- provider-reported (derived: inputTokens - cachedTokens - cacheWriteTokens, protocol-aware)
cacheWriteTokens        -- provider-reported, Anthropic only (cache_creation_input_tokens); ABSENT (not 0) for DeepSeek — no cache-write concept exists to report
cacheHitRate             -- derived from the above two provider-reported numbers, not separately reported by either provider
estimatedSavingsTokens    -- literally `cachedTokens`, relabeled. No dollar figure is computed — CONTINUUM has no authoritative multi-provider pricing table, and inventing one to produce a $ number would be exactly the fabrication the brief rules out.
prefixStable / invalidationReason -- from src/cache/invalidation.ts, CONTINUUM-computed (not provider-reported at all — no provider tells you "your cache is about to invalidate")
```

**A real protocol difference that would have produced silently wrong numbers if missed:** Anthropic's `input_tokens` field already *excludes* cache (fresh-only); DeepSeek's `prompt_tokens` field *includes* it (total). `telemetry.ts` reconstructs `inputTokens` differently per protocol for exactly this reason (`freshTokens + cachedTokens + cacheWriteTokens` for Anthropic; `prompt_tokens` directly for DeepSeek) — verified against `credit-reporter.ts`'s own explicit comment calling out this exact asymmetry, not discovered independently.

**When telemetry is unavailable** (a response with no recognizable usage/cache fields — e.g. a provider this phase doesn't cover, or a malformed response), `parseCacheTelemetry` returns `{ available: false, reason }`, never a fabricated `{ cachedTokens: 0, ... }` that would look like a real, cold-cache result.

### Cache invalidation detection

`hashStablePrefix()` hashes the *deterministically-ordered* stable section (SHA-256), so a hash comparison across turns is meaningful — nondeterministic ordering would produce false invalidation reports even when content genuinely hadn't changed, which is exactly why `orderBlocks`'s determinism (§Architecture doc §3) matters here specifically. `PrefixStabilityTracker` keeps a per-session `Map<sessionKey, lastHash>`, in-memory only — explicitly not a durable store (the Phase 4 hard boundary excludes "durable task/session-state architecture"; building one here would have crossed it).

**A named limitation, not silently absent:** the tracker only retains the *hash*, not the previous envelope's blocks, so `invalidationReason` can describe the current stable section's composition (`"persona=1, scene-index=1"`) but can't name exactly which block changed since last turn. A future phase retaining the full previous envelope could produce a precise per-block diff; not built here since that's session-state retention beyond a single hash — real design tension worth flagging for Phase 5, not solved by scope creep into this one.

## 3. What this means together

A full request path through this phase's code: `buildContextEnvelope` (real MemoryCore data) → `allocateBudget` (real tiktoken counts, deterministic trimming, `instructions` untouchable) → `computeCacheDirectives` (real Anthropic marker, only when the capability supports it) → `renderContextForProvider` (real wire shape) → *(a real API call, not made this phase for Claude/DeepSeek specifically — see PHASE_4_VERIFICATION.md for what was and wasn't live-verified)* → `parseCacheTelemetry` (real field mapping, verified against production billing code) → `PrefixStabilityTracker.check()` (real hash comparison) for the next turn. Every number that could be fabricated instead returns an explicit "unavailable"/"estimate" marker.
