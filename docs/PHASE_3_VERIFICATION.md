# Phase 3 — Provider Adapter Foundation: Verification

Companion to `PHASE_3_PROVIDER_ARCHITECTURE.md`. Every test bullet the task brief listed, what verified it, and the result. CONTINUUM-repo and Tencent-repo verification are kept in separate sections per the brief's "document any Tencent changes separately."

---

## 1. Starting-state verification (before any code was written)

- Phase 2 commit `ea97ab7645d66316b9eef530a57a38792f83ba30` and Phase 2.1 commit `bf5154503234412ee7f3d87f2866f4c9adc14c20` confirmed present via `git show --stat` on `feat/server_team`, in that order, both still unpushed (`git status -sb` showed `ahead 3` of `origin/feat/server_team` — 2 mine + 1 pre-existing).
- `git status --porcelain` before starting matched Phase 2.1's closing state exactly: same 15 pre-existing modified files, same 9 pre-existing untracked paths, nothing extra.
- Live Tencent stack: 10/10 containers healthy (`docker ps`) before any change.

## 2. CONTINUUM provider-registry tests

**Command:** `npx vitest run` in `CONTINUUM/`. **Result: 32/32 passing, 5 files.**

| Brief's test bullet | File | Covered by |
|---|---|---|
| Provider registry lookup | `registry.test.ts` | register+get round-trip, `has()`, `listIds()`/`listProfiles()`, `getCapabilities()` shortcut |
| Unknown provider handling | `registry.test.ts` | `get("gemini")` throws `UnknownProviderError` naming what *is* registered; duplicate-id registration throws `DuplicateProviderError` |
| Claude adapter | `claude-adapter.test.ts` | model resolution, `x-api-key` header construction, CLI launch plan (no key injected, correct `clearEnvVars`/`configDir`), `cli-session` auth honestly refusing to fabricate headers |
| DeepSeek adapter | `deepseek-adapter.test.ts` | model resolution, `Authorization: Bearer` header construction (openai-compatible), proxy-routed CLI launch plan (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` computed correctly, proxy key not DeepSeek's own key) |
| Model mapping | both adapter test files | `default` + named aliases (`fast`/`opus` for Claude, `flash` for DeepSeek) resolve correctly; unmapped alias throws `UnknownModelAliasError` |
| Capability reporting | both adapter test files | `getCapabilities()` returns the profile's stated capabilities verbatim, including DeepSeek's thinking-block caveat |
| Env/auth isolation | `secrets.test.ts`, `deepseek-adapter.test.ts` ("env/auth isolation" test) | `resolveSecret` proven to read only the injected env map, never real `process.env`; cross-provider test proves DeepSeek's launch still fails with only Claude's `ANTHROPIC_API_KEY` set (and vice versa) — no accidental fallback between providers |
| Provider-specific failures | `deepseek-adapter.test.ts` | missing proxy key at CLI-launch time surfaces as `ProviderAuthError` (not a generic error) — distinct from `MissingSecretError` for a missing *direct-call* key, proving the failure taxonomy is meaningful, not just one catch-all |
| No secrets in logs/config/diffs | `no-secrets.test.ts` | both profiles are `JSON.stringify`-safe and scanned for secret-shaped strings (`sk-...`, `AKID...`, PEM headers); every `auth`/`cliLaunch` field carrying a secret is asserted to be a bare `{envVar}` `SecretRef` shape, nothing else |

**Typecheck:** `npx tsc -p tsconfig.json --noEmit` — clean, zero errors, `strict: true`.

## 3. Native Anthropic `LLMRunner` tests (Tencent repo)

**File:** `MemoryCore/src/adapters/standalone/__tests__/anthropic-llm-runner.test.ts` (new — this is MemoryCore's **first** test file; a repo-wide search before writing it found zero existing `*.test.ts` anywhere under `MemoryCore/`). **Command:** `npx vitest run` in `MemoryCore/`. **Result: 8/8 passing.**

All mocked at the `fetch` level (no paid API calls, per the brief) — exercises the real `@ai-sdk/anthropic` request/response handling, not a stubbed-out client:

- Returns the model's text for a pure-text call.
- Sends the resolved key as `x-api-key` (not `Authorization: Bearer`) — protocol correctness.
- System/user prompt land in the request body in Anthropic's actual wire shape (content-block arrays, not raw strings — this is what the first two test-writing attempts got wrong, see §5).
- Token usage lands correctly on the `lastUsage` side-channel — this is what surfaced the pre-existing `StandaloneLLMRunner` bug (§5).
- A simulated 401 (invalid key) propagates as a thrown error, not swallowed.
- `enableTools: false` sends no `tools` field at all (no spurious schema).
- `AnthropicLLMRunnerFactory.createRunner()` honors an explicit `modelRef` and defaults sensibly without one.

## 4. Existing Tencent deployment — regression status

Run **after** all Phase 3 code was written, to catch any real regression:

- **MemoryProxy full suite:** `npm test` → **54/54 passing** — identical count to Phase 2.1's baseline. Phase 3 touched zero MemoryProxy files, so this confirms no accidental cross-contamination, not just "MemoryProxy still works in isolation."
- **MemoryCore full suite:** `npx vitest run` → **8/8 passing** (the new file; nothing else exists to regress).
- **Live stack:** `docker ps` → **10/10 containers still healthy**, unchanged from before Phase 3 started. Phase 3 made no container-affecting change (no `.proxy-config/*.yaml` edits, no `docker run`/`restart` calls) — this check confirms that held, not that anything was fixed.
- **`git status --porcelain` diff, before vs. after:** the same 15 pre-existing modified files and 9 pre-existing untracked paths are present, unchanged, in both snapshots. New entries are exactly: `MemoryCore/package.json` (modified — one dependency line added), `MemoryCore/src/adapters/standalone/llm-runner.ts` (modified — one `export` keyword added), `MemoryCore/src/adapters/standalone/anthropic-llm-runner.ts` (new), `MemoryCore/src/adapters/standalone/__tests__/` (new). Nothing pre-existing was reverted or altered.

## 5. Things this review caught before calling it done

- **Wrong assumption about Anthropic's wire format in my own first test draft:** assumed `system`/user `content` were raw strings; the AI SDK actually sends them as content-block arrays (`[{type:"text", text:"..."}]`). Caught immediately by the test itself failing against the real SDK code path (fetch was mocked, but SDK request-serialization was not) — fixed the *test's* assertions, not the runner (the runner was already doing the right thing; the test's expectation was wrong).
- **Real, pre-existing bug in `StandaloneLLMRunner`** (not introduced this phase): reads `result.usage.promptTokens`/`.completionTokens`, which don't exist on `ai@^6`'s actual `LanguageModelUsage` shape (`inputTokens`/`outputTokens`) — silently reports zero token usage on every real call today. Found via the same failing-test mechanism. `AnthropicLLMRunner` uses the correct field names; `StandaloneLLMRunner` was left as-is per "do not redesign MemoryCore" and is flagged as a Phase 4+ follow-up candidate.

## 6. Pass/fail against the brief's closure criteria

| Criterion | Status |
|---|---|
| 1. Provider selection is data-driven | ✅ — `ProviderRegistry` + `ProviderProfile` objects; zero `if (id === ...)` branches anywhere |
| 2. Claude + DeepSeek work through the same provider abstraction | ✅ — literally the same `createProviderAdapter()` class, not just the same interface |
| 3. Future providers addable without rewriting runtime routing | ✅ (structurally) — adding Gemini/Codex/a local model needs a new profile, and only new adapter code if it needs a genuinely new `auth.kind`/`cliLaunch.kind`; not exercised with a real third provider this phase (out of scope — "full multi-provider parity... sequence after the foundation is proven with Claude + DeepSeek") |
| 4. Native Anthropic MemoryCore runner works through existing interfaces | ✅ — `AnthropicLLMRunner`/`AnthropicLLMRunnerFactory` implement `LLMRunner`/`LLMRunnerFactory` unmodified, 8/8 tests passing; not yet wired into the Gateway's factory selection (deliberately, see architecture doc §5) |
| 5. Secrets remain external | ✅ — `SecretRef`-only in profiles, verified by `no-secrets.test.ts`; no literal credential appears in any file this phase touched (spot-checked via the same secret-shaped-string grep used in Phase 2.1) |
| 6. Tests pass | ✅ — 32/32 (CONTINUUM) + 8/8 (MemoryCore, new) + 54/54 (MemoryProxy, regression) |
| 7. Existing Tencent deployment remains healthy | ✅ — 10/10 containers, confirmed before and after |

**PHASE 3 PASSED.**
