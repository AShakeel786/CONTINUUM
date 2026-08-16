/**
 * Bundled provider presets — Claude, DeepSeek, and Codex declared as the same
 * `ProviderManifest` shape user manifests use, so built-ins flow through the
 * identical manifest→profile→adapter path (no special-casing). These are the
 * canonical definitions; `profiles/*.ts` re-export their derived profiles.
 */

import type { ProviderManifest } from "./manifest.js";

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
    clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
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
  models: { default: "deepseek-v4-pro", aliases: { flash: "deepseek-v4-flash" } },
  capabilities: { thinking: "supported", tools: true, promptCache: "openai-automatic", cliAvailable: true, notes: "Claude Code routed through the Tencent/DeepSeek proxy. Requires DEEPSEEK_API_KEY plus a proxy user key (run `continuum auth deepseek`)." },
  environment: { owns: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] },
  cliLaunch: {
    kind: "proxy-routed",
    configDirName: ".claude-tencent",
    proxyBaseUrl: "http://127.0.0.1:8096",
    proxyPathSuffix: "/claude-code/default",
    proxyUserKeyEnvVar: "CONTINUUM_TENCENT_PROXY_USER_KEY",
    clearEnvVars: [],
    nativeResume: {
      supported: true,
      resume: { kind: "flag", flag: "--resume" },
      sessionStore: { rootDir: "~/.claude-tencent/projects", extension: ".jsonl", idFrom: "basename" },
      sessionIdFlag: "--session-id",
    },
    contextDelivery: { kind: "append-system-prompt", systemFlag: "--append-system-prompt" },
    mcp: { supported: true, serverName: "continuum" },
    mcpLaunch: { kind: "mcp-config-flag", flag: "--mcp-config" },
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
    clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
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
