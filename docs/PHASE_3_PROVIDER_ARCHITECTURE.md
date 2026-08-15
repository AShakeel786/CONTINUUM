# Phase 3 — Provider Adapter Foundation: Architecture

**Scope:** CONTINUUM's provider-independent foundation — a data-driven provider registry, a generic adapter that both Claude and DeepSeek run through unmodified, and a native Anthropic `LLMRunner` for MemoryCore. No Context Manager, Prompt Cache Intelligence, Gemini, handoff, MCP, local models, UI, or Health/Recovery — see `PHASE_4_ENTRY_CRITERIA.md` for what's deferred and why.
**Repos touched:** `CONTINUUM` (new provider-registry code) and `TencentDB-Agent-Memory` (native Anthropic `LLMRunner` only — see §5, kept separate per the task brief).
**Date:** 2026-08-15.

---

## 1. Why this shape

Phase 1's audit (`PHASE_1_EXISTING_SYSTEM_AUDIT.md` §8, `TENCENT_MIGRATION_MAP.md` "Provider Adapters") found the real coupling problem isn't Claude or DeepSeek themselves — DeepSeek is already "just an OpenAI/Anthropic-compatible upstream with quirks." The problem is *where provider identity gets checked*: a 3-way hardcoded `switch` in `windows/launch-tencent-claude.ps1`, and no native Anthropic client anywhere in MemoryCore (`StandaloneLLMRunner` is OpenAI-compatible-only). Phase 3's job is to prove a real abstraction exists — data describing a provider, one adapter that interprets that data — before Gemini/Codex/local models get added on top of it.

**The test that mattered most while designing this:** could Claude and DeepSeek be implemented as the *same adapter class*, differing only in profile data? If not, "data-driven" would just be a thin wrapper around a switch statement in disguise. They are — `createProviderAdapter()` (`src/providers/adapter.ts`) is a single ~110-line class, and `profiles/claude.ts` / `profiles/deepseek.ts` are pure data. Every branch inside the adapter switches on a *union kind* (`auth.kind`, `cliLaunch.kind`) — of which there are few and are provider-agnostic — never on provider identity (`if (id === "claude")` appears nowhere in the codebase).

## 2. Module layout

```text
CONTINUUM/src/providers/
├── types.ts              -- the contract (see §3)
├── errors.ts              -- typed, secret-free errors
├── secrets.ts              -- SecretRef + resolution (env-only, injectable for tests)
├── registry.ts              -- ProviderRegistry (register/get/list/has)
├── adapter.ts               -- createProviderAdapter() — the ONE adapter implementation
├── profiles/
│   ├── claude.ts             -- pure data
│   └── deepseek.ts            -- pure data
├── index.ts                -- public exports + createDefaultProviderRegistry()
└── __tests__/               -- see PHASE_3_VERIFICATION.md
```

No `runtime/`, `router/`, or `context/` modules were added — those are later phases (Agent Router, Context Manager) per `CONTINUUM_ARCHITECTURE.md`'s dependency ordering, and building them now would be exactly the "unified Context Manager" / "launcher redesign" the brief's hard boundary rules out.

## 3. The contract (`types.ts`)

Two kinds of things, deliberately separated:

- **`ProviderProfile`** — pure, JSON-serializable data. Safe to log, diff, or display as-is (verified by test — see `__tests__/no-secrets.test.ts`). Fields: `id`, `displayName`, `protocol`, `baseUrl`, `auth`, `models`, `capabilities`, `environment`, `cliLaunch` — matches the brief's suggested schema, with two additions justified by real system behavior (§4).
- **`ProviderAdapter`** — behavior that *holds* a profile rather than *is* one. `resolveModel()`, `buildAuthHeaders()`, `buildCliLaunchPlan()`, `getCapabilities()`.

### Why `protocol`/`baseUrl`/`auth` and `cliLaunch` are separate fields

This is the one place the brief's suggested schema needed real revision, and it's driven by a concrete fact from the live system, not taste: **DeepSeek is reached two structurally different ways at once today**, and collapsing them into one "protocol" field would have been dishonest about the actual deployment:

1. MemoryCore's own memory-processing calls (L1 extraction, etc.) hit DeepSeek's *native* OpenAI-compatible API directly (`https://api.deepseek.com`, confirmed live in `deploy/global-images/.env`'s `MEMORY_LLM_BASE_URL`).
2. Claude Code CLI sessions reach DeepSeek through the Tencent MemoryProxy, which forwards an Anthropic-shaped request unchanged to DeepSeek's *own* Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`, confirmed live in the proxy's `connectivity.check` log: `"upstream":"https://api.deepseek.com/anthropic"`) — the existing, intentional "impersonation trick."

So: `protocol`/`baseUrl`/`auth` describe path (1) — what a direct API call (a future LLMRunner-style caller) would use. `cliLaunch` describes path (2) — how *this specific deployment* routes an interactive coding-agent session. Claude only has path (1) meaningfully (`cliLaunch.kind: "native"` — no key injected, relies on the CLI's own login) since there's no proxy involved; DeepSeek genuinely needs both, and they use different secrets (DeepSeek's own API key vs. the Tencent proxy's local user key — see R-8's `${PROXY_UPSTREAM_API_KEY}` server-side injection, which means CONTINUUM never even sees DeepSeek's real key on the CLI-launch path).

### `cliLaunch` is data, interpreted generically

```ts
type CliLaunchDescriptor = NativeCliLaunch | ProxyRoutedCliLaunch;
```

`createProviderAdapter().buildCliLaunchPlan()` switches on `cliLaunch.kind` — 2 cases today, both used by real providers. A hypothetical future provider needing a genuinely new launch mechanism (e.g. a local model with no CLI at all) would add a third union member once, not a per-provider branch. This is the concrete mechanism behind closure criterion #3 ("future providers can be added without rewriting runtime routing").

### Auth strategies

`AuthStrategy` is a 4-member discriminated union: `api-key` (Anthropic `x-api-key` or OpenAI-style `Authorization: Bearer`, chosen by `protocol` — not duplicated per provider), `bearer-token`, `cli-session` (deliberately holds no secret — `buildAuthHeaders()` throws `ProviderConfigError` rather than fabricating a header; see "capabilities are never faked" in §4), and `proxy-routed` (secret is the *proxy's* local key, never the upstream provider's real key).

### Secrets (`secrets.ts`)

`SecretRef = { envVar: string }` — a profile can only ever reference *where* a secret lives, never hold one. `resolveSecret(providerId, ref, env?)` is the only place a real value exists in memory, and it accepts an injectable `env` map (defaulting to `process.env`) specifically so tests can prove resolution and cross-provider isolation without touching the real process environment (see Verification §2).

## 4. Capability model

`ProviderCapabilities` is flat and explicit: `protocol`, `thinking` (`"none" | "supported" | "extended"`), `tools`, `promptCache` (`"none" | "anthropic-explicit" | "openai-automatic"`), `cliAvailable`, optional `contextWindowTokens`, `notes`. Per the brief's "do not fake unsupported capabilities": DeepSeek's `thinking: "supported"` (not `"extended"`) explicitly notes the caveat that MemoryProxy's `sanitizeThinkingBlocks` strips DeepSeek's unsigned thinking blocks rather than forwarding them as Anthropic-shaped signed ones — the capability is stated honestly, caveat and all, not rounded up. Neither profile claims `promptCache` support beyond what's real today (no `cache_control` emission exists yet in either path — that's Prompt Cache Intelligence, explicitly deferred).

This metadata isn't consumed by anything yet (there's no later-phase code to consume it) — it exists because the brief asked for it to be available for later phases, and having it typed and tested now means Prompt Cache Intelligence and Token Manager don't have to invent it under time pressure later.

## 5. Native Anthropic `LLMRunner` (Tencent repo — kept separate from CONTINUUM per the brief)

**File:** `MemoryCore/src/adapters/standalone/anthropic-llm-runner.ts` (new). **Not** a CONTINUUM-repo file — this closes the gap Phase 1 found (`StandaloneLLMRunner` is OpenAI-compatible-only) through MemoryCore's own existing extension point.

Verified before writing anything: `LLMRunner`/`LLMRunnerFactory` (`MemoryCore/src/core/types.ts`) are genuinely provider-agnostic — `run(params: LLMRunParams): Promise<string>` and `createRunner(opts?): LLMRunner` have zero OpenAI-specific shape in their signatures. Confirmed this remains the correct extension point before building `AnthropicLLMRunner`/`AnthropicLLMRunnerFactory` to implement it, exactly parallel to `StandaloneLLMRunner`/`StandaloneLLMRunnerFactory`.

**Narrowly scoped, as instructed:**
- No prompt caching (`cache_control` breakpoints) — not implemented.
- No change to how the Gateway picks a factory (`StandaloneHostAdapter` still always constructs `StandaloneLLMRunnerFactory`) — wiring config-driven provider selection into the Gateway would touch `GatewayConfig`/`StandaloneHostAdapter`, which is exactly the "redesign MemoryCore" the brief rules out. `AnthropicLLMRunner` exists, is fully tested, and proves the interface — but isn't reachable from a running Gateway yet. That wiring is explicitly listed as a Phase 4 candidate (`PHASE_4_ENTRY_CRITERIA.md`).
- Reuses `StandaloneLLMRunner`'s exact sandboxed-tool implementation (`createSandboxedTools`, exported — a 1-line change to `llm-runner.ts`, not a rewrite) rather than duplicating ~100 lines of file-tool code.
- Storage-backed (COS) tools intentionally not wired — the brief's "prove the abstraction works" bar is met by the text-only (L1-extraction-shaped) path plus the same sandboxed-FS tool path `StandaloneLLMRunner` already proves.

**A real, pre-existing bug found while testing this (not introduced by this phase):** `StandaloneLLMRunner` reads `result.usage.promptTokens`/`.completionTokens` from the Vercel AI SDK's `generateText()` result. On `ai@^6.0.164` (the version this whole repo is pinned to), `LanguageModelUsage`'s actual fields are `inputTokens`/`outputTokens`/`totalTokens` — the old names don't exist on that object anymore. This means `StandaloneLLMRunner.lastUsage` has been silently reporting `{promptTokens: 0, completionTokens: 0, totalTokens: 0}` on every real call, regardless of actual token consumption, since whenever the SDK was upgraded past whatever version renamed these fields. Caught via a real mocked-response test on the new `AnthropicLLMRunner` (`__tests__/anthropic-llm-runner.test.ts`, "exposes token usage..." — it failed until the field names were corrected). `AnthropicLLMRunner` uses the correct field names. `StandaloneLLMRunner` was **not** touched — this is a real, live bug but fixing it is outside this phase's explicit scope ("do not redesign MemoryCore"); flagged here and in `PHASE_3_VERIFICATION.md` for a follow-up.

## 6. What was deliberately not built

Per the brief's hard boundary: no Context Manager, no Prompt Cache Intelligence (the capability model exists, but nothing emits `cache_control`), no Token Manager, no Gemini/Codex/local-model adapters (the union types leave room, no implementation), no Agent Handoff, no MCP, no UI, and critically **no changes to `windows/launch-tencent-claude.ps1`** — `buildCliLaunchPlan()` produces a plan (`executable`, `args`, `env`, `clearEnvVars`, `configDir`) that is data a *future* launcher rewrite could consume, but nothing in this phase wires it into the real, currently-working PowerShell launcher. The existing Tencent deployment was verified to still work through its existing, untouched code path (`PHASE_3_VERIFICATION.md` §4).
