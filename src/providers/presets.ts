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
      sessionStore: { rootDir: "~/.claude/projects", extension: ".jsonl", idFrom: "basename" },
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
      sessionStore: { rootDir: "~/.claude-deepseek/projects", extension: ".jsonl", idFrom: "basename" },
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
      sessionStore: { rootDir: "~/.claude-tencent/projects", extension: ".jsonl", idFrom: "basename" },
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
  cliLaunch: {
    kind: "native",
    clearEnvVars: [...MODEL_IDENTITY_ENV_VARS, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    nativeResume: {
      supported: true,
      resume: { kind: "subcommand", subcommand: "resume" },
      sessionStore: { rootDir: "~/.codex/sessions", extension: ".jsonl", idFrom: "session-meta", metaRecordType: "session_meta", metaPayloadField: "session_id" },
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

export const bundledManifests: readonly ProviderManifest[] = [claudeManifest, deepseekManifest, codexManifest];
