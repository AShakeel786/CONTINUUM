/**
 * Bundled provider presets — Claude, DeepSeek, and Codex declared as the same
 * `ProviderManifest` shape user manifests use, so built-ins flow through the
 * identical manifest→profile→adapter path (no special-casing). These are the
 * canonical definitions; `profiles/*.ts` re-export their derived profiles.
 */

import type { ProviderManifest } from "./manifest.js";

/**
 * The model-identity env vars Claude Code reads to label its primary and
 * per-tier/subagent models. CONTINUUM sets these only for `redirected`/
 * `proxy-routed` (DeepSeek) launches via the adapter's `modelIdentityEnv`.
 * A `native` launch must therefore CLEAR them — otherwise a prior DeepSeek
 * run's model (e.g. `ANTHROPIC_MODEL=deepseek-v4-pro`) leaks into native
 * Claude/Codex and silently re-selects the wrong model. This list is the
 * single source of truth shared with the adapter (see `modelIdentityEnv`).
 */
export const MODEL_IDENTITY_ENV_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/** Google Gemini Developer API through its documented OpenAI compatibility surface. */
export const geminiFreeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "gemini-free",
  displayName: "Gemini Free",
  protocol: "openai-compatible",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  auth: { kind: "bearer-token", envVar: "GEMINI_API_KEY" },
  billing: "free",
  models: { default: "gemini-3.7-flash" },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "none",
    cliAvailable: false,
    contextWindowTokens: 1_048_576,
    notes: "Gemini Developer API free tier through the OpenAI-compatible chat-completions endpoint.",
  },
  environment: { owns: ["GEMINI_API_KEY"] },
};

/** Groq free-plan API through its OpenAI-compatible endpoint. */
export const groqFreeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "groq-free",
  displayName: "Groq Free",
  protocol: "openai-compatible",
  baseUrl: "https://api.groq.com/openai/v1",
  auth: { kind: "bearer-token", envVar: "GROQ_API_KEY" },
  billing: "free",
  models: {
    default: "openai/gpt-oss-120b",
    aliases: { fast: "openai/gpt-oss-20b", qwen: "qwen/qwen3.6-27b" },
  },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "openai-automatic",
    cliAvailable: false,
    contextWindowTokens: 131_072,
    notes: "Groq free-plan inference; Retry-After and x-ratelimit-reset-* are honored by the shared API runner.",
  },
  environment: { owns: ["GROQ_API_KEY"] },
};

/**
 * OpenRouter's zero-cost router. Deliberately exposes one model id and no
 * aliases: DataDrivenProviderAdapter rejects every unknown model, so this
 * provider can never silently resolve to a paid OpenRouter model.
 */
export const openRouterFreeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "openrouter-free",
  displayName: "OpenRouter Free",
  protocol: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  auth: { kind: "bearer-token", envVar: "OPENROUTER_API_KEY" },
  billing: "free",
  models: { default: "openrouter/free" },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "openai-automatic",
    cliAvailable: false,
    contextWindowTokens: 200_000,
    notes: "OpenRouter zero-cost router only. Internal free-model selection is OpenRouter behavior; CONTINUUM failover remains provider-level.",
  },
  environment: { owns: ["OPENROUTER_API_KEY"] },
};

export const claudeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "claude",
  displayName: "Claude",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  auth: { kind: "api-key", envVar: "ANTHROPIC_API_KEY" },
  billing: "paid",
  models: {
    default: "claude-sonnet-5",
    aliases: { fast: "claude-haiku-4-5-20251001", opus: "claude-opus-5", fable: "claude-fable-5" },
  },
  capabilities: {
    thinking: "extended",
    tools: true,
    promptCache: "anthropic-explicit",
    cliAvailable: true,
    contextWindowTokens: 200_000,
    notes: "Native Claude Code (Anthropic). Uses the `claude` CLI's own login (`claude auth login`); this is NOT the Tencent/DeepSeek proxy path — that is the `deepseek` provider.",
  },
  environment: { owns: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"] },
  cliLaunch: {
    kind: "native",
    configDirName: ".claude-anthropic",
    clearEnvVars: [...MODEL_IDENTITY_ENV_VARS, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    statusLineCommand: "continuum-statusline",
    // Full access by default: the central launcher defaults every CLI-backed
    // launch to bypass, honoring this verified Claude Code flag. Explicit
    // `--safe` still selects normal approval mode.
    permissionBypassFlag: "--dangerously-skip-permissions",
    nativeResume: {
      supported: true,
      resume: { kind: "flag", flag: "--resume" },
      sessionStore: { kind: "files", rootDir: "~/.claude/projects", extension: ".jsonl", idFrom: "basename" },
      sessionIdFlag: "--session-id",
    },
    mcp: { supported: true, serverName: "continuum" },
    contextDelivery: { kind: "append-system-prompt", systemFlag: "--append-system-prompt" },
    mcpLaunch: { kind: "mcp-config-flag", flag: "--mcp-config" },
  },
  cli: {
    supported: true,
    executable: "claude",
    versionArgs: ["--version"],
    statusArgs: ["auth", "status"],
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
  },
};

export const deepseekManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "deepseek",
  displayName: "DeepSeek",
  protocol: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  auth: { kind: "api-key", envVar: "DEEPSEEK_API_KEY" },
  billing: "paid",
  models: { default: "deepseek-v4-flash", aliases: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" } },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "openai-automatic",
    cliAvailable: true,
    notes: "Claude Code redirected to DeepSeek's own Anthropic-compatible endpoint (https://api.deepseek.com/anthropic). Requires only DEEPSEEK_API_KEY — no Docker/Tencent/MemoryProxy. An optional Tencent MemoryProxy route is available via `continuum auth deepseek --proxy`.",
  },
  environment: { owns: ["DEEPSEEK_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] },
  cliLaunch: {
    kind: "redirected",
    configDirName: ".claude-deepseek",
    baseUrl: "https://api.deepseek.com/anthropic",
    authTokenEnvVar: "DEEPSEEK_API_KEY",
    clearEnvVars: [...MODEL_IDENTITY_ENV_VARS, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    statusLineCommand: "continuum-statusline",
    // Full access by default: this route still spawns Claude Code (redirected
    // to DeepSeek's Anthropic-compatible endpoint), so the same verified
    // Claude Code bypass flag applies. Explicit `--safe` opts back out.
    permissionBypassFlag: "--dangerously-skip-permissions",
    nativeResume: {
      supported: true,
      resume: { kind: "flag", flag: "--resume" },
      sessionStore: { kind: "files", rootDir: "~/.claude-deepseek/projects", extension: ".jsonl", idFrom: "basename" },
      sessionIdFlag: "--session-id",
    },
    contextDelivery: { kind: "append-system-prompt", systemFlag: "--append-system-prompt" },
    mcp: { supported: true, serverName: "continuum" },
    mcpLaunch: { kind: "mcp-config-flag", flag: "--mcp-config" },
    // CONTINUUM's economic policy is stricter than Claude Code's provider
    // mapping: every implicit Claude tier is Flash. Pro is only selected by
    // an explicit user model choice and is never inferred from the opus alias,
    // task difficulty, retries, or context size.
    modelTierMap: { opus: "flash", sonnet: "flash", haiku: "flash", subagent: "flash" },
  },
  // Optional Tencent MemoryProxy route — only used when explicitly enabled
  // (`continuum auth deepseek --proxy`, or config.proxyRouting.deepseek="proxy").
  // Never inferred merely because Tencent code/containers exist on the machine.
  proxyCliLaunch: {
    kind: "proxy-routed",
    configDirName: ".claude-tencent",
    proxyBaseUrl: "http://127.0.0.1:8096",
    proxyPathSuffix: "/claude-code/default",
    proxyUserKeyEnvVar: "CONTINUUM_TENCENT_PROXY_USER_KEY",
    clearEnvVars: [...MODEL_IDENTITY_ENV_VARS, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    statusLineCommand: "continuum-statusline",
    // Full access by default: same verified Claude Code flag as the direct
    // route — the proxy-routed launch also spawns Claude Code (pointed at the
    // Tencent MemoryProxy). Explicit `--safe` opts back out.
    permissionBypassFlag: "--dangerously-skip-permissions",
    nativeResume: {
      supported: true,
      resume: { kind: "flag", flag: "--resume" },
      sessionStore: { kind: "files", rootDir: "~/.claude-tencent/projects", extension: ".jsonl", idFrom: "basename" },
      sessionIdFlag: "--session-id",
    },
    contextDelivery: { kind: "append-system-prompt", systemFlag: "--append-system-prompt" },
    mcp: { supported: true, serverName: "continuum" },
    mcpLaunch: { kind: "mcp-config-flag", flag: "--mcp-config" },
    // Same Flash-only implicit tier mapping as the direct route.
    modelTierMap: { opus: "flash", sonnet: "flash", haiku: "flash", subagent: "flash" },
  },
  proxyUserKey: { envVar: "CONTINUUM_TENCENT_PROXY_USER_KEY", credentialName: "proxy-user-key" },
};

export const codexManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "codex",
  displayName: "Codex",
  protocol: "openai-compatible",
  baseUrl: "https://api.openai.com",
  auth: { kind: "cli-session" },
  billing: "paid",
  models: {
    default: "gpt-5.6-sol",
    aliases: { terra: "gpt-5.6-terra", luna: "gpt-5.6-luna", mini: "gpt-5.4-mini" },
  },
  capabilities: { thinking: "extended", tools: true, promptCache: "openai-automatic", cliAvailable: true, notes: "Native Codex CLI (OpenAI). Uses the `codex` CLI's own ChatGPT login." },
  environment: { owns: ["OPENAI_API_KEY", "CODEX_HOME", "CODEX_ACCESS_TOKEN"] },
  // Full access by default: the central launcher defaults every CLI-backed
  // launch to bypass, honoring this verified native Codex flag. Explicit
  // `--safe` still selects normal approval mode.
  // Live model discovery from the CLI's own model cache (~/.codex/models_cache.json),
  // falling back to the manifest list when the cache is absent/unreadable.
  modelDiscovery: { kind: "json-cache", path: "~/.codex/models_cache.json" },
  cliLaunch: {
    kind: "native",
    modelFlag: "-m",
    permissionBypassFlag: "--dangerously-bypass-approvals-and-sandbox",
    clearEnvVars: [...MODEL_IDENTITY_ENV_VARS, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    nativeResume: {
      supported: true,
      resume: { kind: "subcommand", subcommand: "resume" },
      sessionStore: { kind: "files", rootDir: "~/.codex/sessions", extension: ".jsonl", idFrom: "session-meta", metaRecordType: "session_meta", metaPayloadField: "session_id" },
    },
    mcp: { supported: true, serverName: "continuum" },
    contextDelivery: { kind: "prompt-only" },
    mcpLaunch: { kind: "global-config" },
  },
  cli: {
    supported: true,
    executable: "codex",
    versionArgs: ["--version"],
    statusArgs: ["login", "status"],
    loginArgs: ["login"],
    logoutArgs: ["logout"],
  },
};

/**
 * Antigravity (Google) — the authenticated `agy` CLI. Native `agy` launch
 * with `cli-session` auth: CONTINUUM reuses `agy`'s own Google OAuth login
 * (stored under `~/.gemini/` + the system keyring) and never reads/stores/
 * copies any credential. No API key, no Gemini CLI, no Tencent/proxy.
 *
 * Model selection is `--model <id>` (verified against `agy --help` and the
 * live `agy models` list); resume is `--conversation <id>` (verified flag),
 * with the id discovered read-only from `agy`'s own SQLite session index.
 * `agy` has no `--session-id` flag, so a fresh launch generates its own
 * conversation id and the launcher captures it from the store after spawn —
 * the same store-scan fallback Codex uses.
 */
export const antigravityManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "antigravity",
  displayName: "Antigravity",
  protocol: "openai-compatible",
  baseUrl: "https://antigravity.google",
  auth: { kind: "cli-session" },
  billing: "paid",
  models: {
    default: "gemini-3.7-flash-high",
    aliases: {
      high: "gemini-3.7-flash-high",
      medium: "gemini-3.7-flash-medium",
      low: "gemini-3.7-flash-low",
      flash: "gemini-3.7-flash-low",
      pro: "gemini-3.1-pro-high",
    },
  },
  capabilities: {
    thinking: "extended",
    tools: true,
    promptCache: "openai-automatic",
    cliAvailable: true,
    contextWindowTokens: 1_000_000,
    notes: "Native Antigravity CLI (Google). Uses the `agy` CLI's own Google OAuth login; CONTINUUM holds no credential and injects no key.",
  },
  environment: { owns: [] },
  // Full access by default: the central launcher defaults every CLI-backed
  // launch to bypass, honoring this verified native agy flag. Explicit
  // `--safe` still selects normal approval mode.
  // Live model discovery from the installed `agy` CLI's own `models` subcommand
  // (verified locally), falling back to the manifest list when it fails.
  modelDiscovery: { kind: "cli-command", command: ["models"] },
  cliLaunch: {
    kind: "native",
    modelFlag: "--model",
    permissionBypassFlag: "--dangerously-skip-permissions",
    clearEnvVars: [],
    nativeResume: {
      supported: true,
      resume: { kind: "flag", flag: "--conversation" },
      sessionStore: {
        kind: "sqlite",
        dbPath: "~/.gemini/antigravity-cli/conversation_summaries.db",
        table: "conversation_summaries",
        idColumn: "conversation_id",
        mtimeColumn: "last_modified_time",
      },
    },
    mcp: { supported: false },
    contextDelivery: { kind: "prompt-only" },
  },
  cli: {
    supported: true,
    executable: "agy",
    versionArgs: ["--version"],
    // agy has no `auth status`/`login status` subcommand: install detection is
    // `agy --version`, and authenticated detection is the local, non-secret
    // `~/.gemini/google_accounts.json` active-account + token-expiry check in
    // `auth/provider-auth/antigravity.ts`. `loginArgs` runs bare `agy`, whose
    // interactive OAuth flow fires when not signed in.
    loginArgs: [],
    logoutArgs: [],
  },
};

/**
 * Ox Alpha Free — a time-boxed free preview coding model (the same model
 * OpenCode Go exposes as `ox-alpha-free`), reached through OpenRouter as
 * `stealth/ox-alpha`.
 *
 * Two harnesses, one credential (OpenRouter API key, stored via
 * `continuum auth ox-alpha` in the OS credential store, never in this repo):
 *   - Preferred: Claude Code, redirected to OpenRouter's Anthropic-compatible
 *     endpoint (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`) with the wire
 *     model set through Claude Code's documented `modelOverrides` mechanism
 *     (catalog alias client-side, `stealth/ox-alpha` on the wire).
 *   - Fallback (`apiFallback`): CONTINUUM's generic direct-API agent loop,
 *     selected automatically when the `claude` executable is unavailable.
 * The `promo` block marks the limited-time free window — while it is active,
 * automatic preference routing may select it; a declared-and-passed `until`
 * would stop advertising/auto-preference, but the provider stays explicitly
 * selectable.
 */
export const oxAlphaManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "ox-alpha",
  displayName: "Ox Alpha Free",
  protocol: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  auth: { kind: "bearer-token", envVar: "OPENROUTER_API_KEY" },
  billing: "free",
  models: { default: "stealth/ox-alpha" },
  capabilities: {
    cliAvailable: true,
    contextWindowTokens: 1_000_000,
    notes: "OpenRouter — stealth/ox-alpha (Ox Alpha Free). Runs Claude Code redirected to OpenRouter's Anthropic-compatible endpoint (modelOverrides → stealth/ox-alpha), with the direct API-agent as an automatic fallback harness when the claude CLI is unavailable. Limited-time free preview; the OpenRouter API key is stored via `continuum auth ox-alpha` (never in this repo).",
  },
  environment: { owns: ["OPENROUTER_API_KEY"] },
  apiFallback: true,
  // Full access by default: the central launcher defaults every CLI-backed
  // launch to bypass, honoring this descriptor's verified Claude Code flag.
  // Explicit `--safe` still selects normal approval mode.
  cliLaunch: {
    kind: "redirected",
    // A dedicated config dir so ox sessions never touch the user's global
    // Claude config (~/.claude) or DeepSeek's (~/.claude-deepseek).
    configDirName: ".claude-oxalpha",
    baseUrl: "https://openrouter.ai/api",
    authTokenEnvVar: "OPENROUTER_API_KEY",
    clearEnvVars: [...MODEL_IDENTITY_ENV_VARS, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
    statusLineCommand: "continuum-statusline",
    // Full access by default: same verified Claude Code flag the native
    // Claude and DeepSeek routes use. Explicit `--safe` opts back out.
    permissionBypassFlag: "--dangerously-skip-permissions",
    nativeResume: {
      supported: true,
      resume: { kind: "flag", flag: "--resume" },
      sessionStore: { kind: "files", rootDir: "~/.claude-oxalpha/projects", extension: ".jsonl", idFrom: "basename" },
      sessionIdFlag: "--session-id",
    },
    contextDelivery: { kind: "append-system-prompt", systemFlag: "--append-system-prompt" },
    mcp: { supported: true, serverName: "continuum" },
    mcpLaunch: { kind: "mcp-config-flag", flag: "--mcp-config" },
    // Every Claude Code tier maps to the single provider model on the wire
    // ("default" resolves through `resolveModel`, same as any alias key).
    modelTierMap: { opus: "default", sonnet: "default", haiku: "default", subagent: "default" },
  },
  // Limited-time free preview: no authoritative end timestamp is published
  // upstream, so `until` is deliberately omitted (never guessed). Routing
  // preference therefore follows current usability, not a date.
  promo: { note: "FREE" },
};
// Live-compatibility note (not an ox incompatibility): on FIRST run in a
// workspace, Claude Code shows its own workspace-trust dialog and ignores
// `.claude/settings.json` allow-lists until the user accepts it once
// (`~/.claude-oxalpha/.claude.json`). That is standard interactive Claude
// Code behavior, identical for native Claude and DeepSeek launches.

/**
 * Cloudflare Workers AI — OpenAI-compatible inference under a Cloudflare
 * account. `account_id` is a NON-SECRET endpoint path param supplied via the
 * `CLOUDFLARE_ACCOUNT_ID` env var (never a stored secret); the API token is a
 * stored credential (`continuum auth cloudflare-workers-ai-free`).
 *
 * Declared `free` but deliberately NOT pool-eligible: the Free plan hard-stops
 * at the daily 10k-neuron allocation, but a Paid-plan account silently bills
 * above it — CONTINUUM cannot prove hard-stop for the configured account, so
 * it is only reached under explicit paid-fallback policy, never auto-picked.
 */
export const cloudflareWorkersAiFreeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "cloudflare-workers-ai-free",
  displayName: "Cloudflare Workers AI",
  protocol: "openai-compatible",
  baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
  auth: { kind: "bearer-token", envVar: "CLOUDFLARE_API_TOKEN" },
  billing: "free",
  freeOnlyEligible: false,
  endpointParams: { account_id: "CLOUDFLARE_ACCOUNT_ID" },
  models: { default: "@cf/meta/llama-3.1-8b-instruct" },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "none",
    cliAvailable: false,
    contextWindowTokens: 131_072,
    notes: "Workers AI free daily allocation (10k neurons/day, resets 00:00 UTC) hard-stops on the Free plan; a Paid-plan account bills above the allocation. Requires a non-secret CLOUDFLARE_ACCOUNT_ID in the shell environment plus a stored CLOUDFLARE_API_TOKEN. Default model is the historical free llama-3.1-8b — verify the current free catalog before real use.",
  },
  environment: { owns: ["CLOUDFLARE_API_TOKEN"] },
};

/**
 * Cerebras — free trial tier, explicitly classified trial/promotional (never
 * a permanent free provider): per-model rate limits (5 RPM / 30K TPM / 1M TPD)
 * return a hard 429 and billing only starts when credits are purchased. May
 * participate ahead of paid providers under explicit paid-fallback policy.
 */
export const cerebrasTrialManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "cerebras-trial",
  displayName: "Cerebras Trial",
  protocol: "openai-compatible",
  baseUrl: "https://api.cerebras.ai/v1",
  auth: { kind: "bearer-token", envVar: "CEREBRAS_API_KEY" },
  billing: "trial",
  models: { default: "gpt-oss-120b" },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "none",
    cliAvailable: false,
    contextWindowTokens: 131_072,
    notes: "Cerebras free trial tier (gpt-oss-120b, gemma-4-31b). Rate-limited hard stop → 429; paid requires a separate credit purchase. Classified trial/promotional, excluded from the automatic free pool.",
  },
  environment: { owns: ["CEREBRAS_API_KEY"] },
};

/**
 * NVIDIA — NIM hosted API on build.nvidia.com. Free developer access is
 * reported (~40 RPM, no credit card on file) but the billing guarantee is NOT
 * verified from official docs, so per the freeOnly rule it is classified
 * trial/promotional and excluded from the automatic free pool.
 */
export const nvidiaFreeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "nvidia-free",
  displayName: "NVIDIA Free",
  protocol: "openai-compatible",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  auth: { kind: "bearer-token", envVar: "NVIDIA_API_KEY" },
  billing: "trial",
  models: { default: "meta/llama-3.3-70b-instruct" },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "none",
    cliAvailable: false,
    contextWindowTokens: 131_072,
    notes: "NVIDIA NIM hosted API. Free tier reported ~40 RPM with no card on file (no silent auto-bill), but not confirmed from official docs — classified trial and excluded from the automatic free pool. Verify the current free model catalog before real use.",
  },
  environment: { owns: ["NVIDIA_API_KEY"] },
};

/**
 * HuggingFace Inference Providers — OpenAI-compatible router. Free users get
 * monthly credits ($0.10) and must purchase credits to continue; a
 * credit-purchasing account deducts automatically, so a hard free-credit-only
 * stop is not enforceable. Classified trial and excluded from the free pool.
 */
export const huggingFaceFreeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "huggingface-free",
  displayName: "HuggingFace Free",
  protocol: "openai-compatible",
  baseUrl: "https://router.huggingface.co/v1",
  auth: { kind: "bearer-token", envVar: "HF_TOKEN" },
  billing: "trial",
  models: { default: "openai/gpt-oss-120b" },
  capabilities: {
    thinking: "supported",
    tools: true,
    promptCache: "none",
    cliAvailable: false,
    contextWindowTokens: 131_072,
    notes: "HuggingFace Inference Providers router (openai/gpt-oss-120b recommended free-tier model). Free monthly credits hard-stop only for accounts that never purchased credits — not enforceable, so classified trial and excluded from the automatic free pool.",
  },
  environment: { owns: ["HF_TOKEN"] },
};

/**
 * Automatic provider-preference chain: when a launch carries no explicit
 * provider/model selection, the launcher walks this list (skipping expired
 * promos and unusable providers) and picks the first usable one. The stable
 * free pool (Gemini → Groq → OpenRouter → Ox Alpha) is preferred first. The
 * trial/non-pool-eligible additions (Cerebras, NVIDIA, HuggingFace,
 * Cloudflare) are skipped under default free-only policy — they are reached
 * only with explicit paid-fallback permission, where they participate ahead
 * of the paid DeepSeek provider. An explicit user/provider/model selection
 * always overrides this chain.
 */
export const DEFAULT_PROVIDER_PREFERENCE_CHAIN: readonly string[] = [
  "gemini-free",
  "groq-free",
  "openrouter-free",
  "ox-alpha",
  "cerebras-trial",
  "nvidia-free",
  "huggingface-free",
  "cloudflare-workers-ai-free",
  "deepseek",
];

export const bundledManifests: readonly ProviderManifest[] = [
  claudeManifest,
  deepseekManifest,
  codexManifest,
  antigravityManifest,
  geminiFreeManifest,
  groqFreeManifest,
  openRouterFreeManifest,
  oxAlphaManifest,
  cerebrasTrialManifest,
  nvidiaFreeManifest,
  huggingFaceFreeManifest,
  cloudflareWorkersAiFreeManifest,
];
