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

export const claudeManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "claude",
  displayName: "Claude",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  auth: { kind: "api-key", envVar: "ANTHROPIC_API_KEY" },
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
  models: {
    default: "gpt-5.6-sol",
    aliases: { terra: "gpt-5.6-terra", luna: "gpt-5.6-luna", mini: "gpt-5.4-mini" },
  },
  capabilities: { thinking: "extended", tools: true, promptCache: "openai-automatic", cliAvailable: true, notes: "Native Codex CLI (OpenAI). Uses the `codex` CLI's own ChatGPT login." },
  environment: { owns: ["OPENAI_API_KEY", "CODEX_HOME", "CODEX_ACCESS_TOKEN"] },
  // Full access by default: this workflow launches Codex with tool approvals
  // skipped via the CLI's own verified `--dangerously-bypass-approvals-and-
  // sandbox` flag. Explicit `--safe` still selects normal approval mode.
  defaultPermissionMode: "bypass",
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
  // Full access by default: this workflow launches `agy` with tool approvals
  // skipped via the CLI's own verified `--dangerously-skip-permissions` flag.
  // Explicit `--safe` still selects normal approval mode.
  defaultPermissionMode: "bypass",
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
 * OpenCode Go exposes as `ox-alpha-free`), reached through OpenRouter's
 * OpenAI-compatible API as `stealth/ox-alpha`. Direct-API only (no coding-
 * agent CLI exists for it): CONTINUUM's own api-agent runtime speaks to
 * `https://openrouter.ai/api/v1` with the user's OpenRouter API key
 * (stored via `continuum auth ox-alpha` in the OS credential store, never
 * in this repo). The `promo` block marks the limited-time free window —
 * while it is active, automatic preference routing may select it; after
 * `until` it is no longer advertised or auto-preferred, but stays
 * explicitly selectable.
 */
export const oxAlphaManifest: ProviderManifest = {
  schemaVersion: 1,
  id: "ox-alpha",
  displayName: "Ox Alpha Free",
  protocol: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  auth: { kind: "bearer-token", envVar: "OPENROUTER_API_KEY" },
  models: { default: "stealth/ox-alpha" },
  capabilities: {
    cliAvailable: false,
    contextWindowTokens: 1_000_000,
    notes: "OpenRouter — stealth/ox-alpha (Ox Alpha Free, the same model OpenCode Go lists as ox-alpha-free). Limited-time free preview; requires an OpenRouter API key stored via `continuum auth ox-alpha` (never in this repo).",
  },
  environment: { owns: ["OPENROUTER_API_KEY"] },
  // Limited-time free preview: no authoritative end timestamp is published
  // upstream, so `until` is deliberately omitted (never guessed). Routing
  // preference therefore follows current usability, not a date.
  promo: { note: "FREE" },
};

/**
 * Automatic provider-preference chain: when a launch carries no explicit
 * provider/model selection, the launcher walks this list (skipping expired
 * promos and unusable providers) and picks the first usable one. Ox Alpha
 * Free is preferred while its promo is active; DeepSeek is the fallback.
 * An explicit user/provider/model selection always overrides this chain.
 */
export const DEFAULT_PROVIDER_PREFERENCE_CHAIN: readonly string[] = ["ox-alpha", "deepseek"];

export const bundledManifests: readonly ProviderManifest[] = [claudeManifest, deepseekManifest, codexManifest, antigravityManifest, oxAlphaManifest];
