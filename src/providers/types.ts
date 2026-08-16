/**
 * Provider contract — the shared shape every provider (Claude, DeepSeek,
 * and later Gemini/Codex/local models) implements. Nothing in CONTINUUM's
 * runtime should need to know which concrete provider it's talking to;
 * it should only need this contract plus a ProviderRegistry lookup.
 *
 * Design note: this is deliberately data-first. `ProviderProfile` is plain,
 * serializable, secret-free data (safe to log/inspect as-is). Behavior
 * (auth header construction, CLI launch planning) lives in a separate
 * `ProviderAdapter` that *holds* a profile rather than a profile that
 * *is* an adapter — so profiles can be diffed/tested/displayed without
 * dragging code along, matching the brief's request for "a clean provider
 * contract/config rather than hardcoded switch statements."
 */

import type { SecretRef } from "./secrets.js";

// ── Wire protocol ──────────────────────────────────────────────────────
//
// The protocol CONTINUUM's own adapter speaks when making a direct API call
// to this provider (used by e.g. a native LLMRunner). This is distinct from
// how a coding-agent CLI is *launched* against the provider (see
// CliLaunchAdapter below) — DeepSeek's CLI-launch path routes through the
// Tencent proxy pretending to be Anthropic's wire shape (the existing,
// intentional "impersonation trick"), while DeepSeek's own native API,
// which is what a direct LLMRunner call would use, is OpenAI-compatible.
// Those are two different concerns and must not be collapsed into one field.
export type Protocol = "anthropic-messages" | "openai-compatible";

// ── Auth ────────────────────────────────────────────────────────────────

/** Sent as `x-api-key` (Anthropic-style) using a resolved SecretRef. */
export interface ApiKeyAuth {
  readonly kind: "api-key";
  readonly secret: SecretRef;
}

/** Sent as `Authorization: Bearer <token>` using a resolved SecretRef. */
export interface BearerTokenAuth {
  readonly kind: "bearer-token";
  readonly secret: SecretRef;
}

/**
 * No secret is held by CONTINUUM at all — the provider is reached through
 * an already-authenticated CLI session (e.g. `claude` after its own
 * interactive login). Matches the existing native-Claude launcher path,
 * which deliberately clears every Tencent/proxy env var rather than
 * injecting a key.
 */
export interface CliSessionAuth {
  readonly kind: "cli-session";
  readonly note?: string;
}

/**
 * Reached through the Tencent MemoryProxy rather than directly. The secret
 * resolved here is the proxy-local admin/user key (`x-tdai-user-key`
 * equivalent), NOT the upstream provider's own API key — the proxy holds
 * that separately server-side (see MemoryProxy R-8: `${PROXY_UPSTREAM_API_KEY}`).
 */
export interface ProxyRoutedAuth {
  readonly kind: "proxy-routed";
  readonly secret: SecretRef;
  /** The proxy base URL this provider is reached through, e.g. `http://127.0.0.1:8096`. */
  readonly proxyBaseUrl: string;
}

export type AuthStrategy = ApiKeyAuth | BearerTokenAuth | CliSessionAuth | ProxyRoutedAuth;

// ── Model mapping ─────────────────────────────────────────────────────

/**
 * Logical alias -> real provider model id. `default` is required; other
 * aliases are provider-specific (e.g. "fast", "reasoning"). Mirrors the
 * shape already proven in MemoryProxy's `upstream.agents[<name>]` config
 * table, generalized to a first-class type instead of ad hoc YAML.
 */
export interface ModelMapping {
  readonly default: string;
  readonly aliases?: Readonly<Record<string, string>>;
}

// ── Capabilities ─────────────────────────────────────────────────────

export type ThinkingSupport = "none" | "supported" | "extended";
export type PromptCacheMode = "none" | "anthropic-explicit" | "openai-automatic";

/**
 * What a provider can actually do, stated explicitly rather than assumed.
 * Consumed by later phases (Prompt Cache Intelligence, Token Manager) —
 * kept flat and honest here; unsupported capabilities are never faked.
 */
export interface ProviderCapabilities {
  readonly protocol: Protocol;
  readonly thinking: ThinkingSupport;
  readonly tools: boolean;
  readonly promptCache: PromptCacheMode;
  /** Whether a CLI binary integration exists in CONTINUUM today (not just in principle). */
  readonly cliAvailable: boolean;
  /** Advertised context window, when known. Omitted rather than guessed. */
  readonly contextWindowTokens?: number;
  readonly notes?: string;
}

// ── Environment ownership ──────────────────────────────────────────────

/**
 * Which environment variables this provider's CLI-launch path sets. Lets a
 * launcher clear exactly what a provider declares instead of the current
 * Tencent launcher's one big shared pattern-list (see
 * CONTINUUM_ARCHITECTURE.md, CLI/Launcher section).
 */
export interface EnvironmentOwnership {
  readonly owns: readonly string[];
}

// ── CLI launch descriptor (data, not behavior) ──────────────────────────
//
// How THIS deployment routes a coding-agent CLI to reach the provider for
// an interactive session — distinct from `protocol`/`baseUrl`/`auth` above,
// which describe a direct API call (e.g. from a native LLMRunner). A
// provider can legitimately use both paths at once: DeepSeek is reached
// directly (openai-compatible) for MemoryCore's own memory-processing
// calls, and via the Tencent proxy's Anthropic-impersonation trick for
// Claude Code CLI sessions. Modeled as data so `createProviderAdapter`
// (adapter.ts) can build a launch plan generically, by switching on *launch
// mechanism kind* (of which there are few and provider-agnostic), never on
// provider identity.

/** Launch the CLI directly against the provider's own native login/session. */
export interface NativeCliLaunch {
  readonly kind: "native";
  readonly executable: string;
  /**
   * Optional Claude-specific config dir name. Only Claude-family CLIs read
   * `CLAUDE_CONFIG_DIR`; a provider whose CLI uses its own config home (e.g.
   * Codex's `~/.codex`) omits this and the launcher injects nothing.
   */
  readonly configDirName?: string;
  /**
   * Env vars to clear before launch, in case a previous session (a
   * different provider, or a different agent system entirely) left them
   * set and would otherwise silently redirect this one. Mirrors the real
   * Tencent launcher's env-sanitization-before-launch pattern.
   */
  readonly clearEnvVars: readonly string[];
  /** Native-session resume capability (declared as data — see below). */
  readonly nativeResume?: NativeResumeDescriptor;
}

/**
 * Launch the CLI redirected through the Tencent MemoryProxy, which forwards
 * requests unchanged to the real upstream (see MemoryProxy README: "changes
 * no protocol"). Preserves the existing, intentional
 * `sessionInit.headerAutoSelect.onMismatch: "bypass"` deployment behavior —
 * this descriptor doesn't touch that setting, it just targets the same
 * already-running proxy.
 */
export interface ProxyRoutedCliLaunch {
  readonly kind: "proxy-routed";
  readonly executable: string;
  readonly configDirName: string;
  readonly proxyBaseUrl: string;
  readonly proxyPathSuffix: string;
  readonly proxyUserKeySecret: SecretRef;
  readonly clearEnvVars: readonly string[];
  /** Native-session resume capability (declared as data — see below). */
  readonly nativeResume?: NativeResumeDescriptor;
}

export type CliLaunchDescriptor = NativeCliLaunch | ProxyRoutedCliLaunch;

// ── Native session resume (data, not behavior) ───────────────────────────
//
// A provider whose CLI keeps its own native session store can declare how to
// resume a session *by id* and where its session files live, so a generic
// bridge (launcher/runtime) can build resume args and (best-effort) discover
// the most-recent native session id without ever switching on provider id.

/** How a resume invocation is shaped. `flag` → `<flag> <id>`; `subcommand` → `<subcommand> <id>`. */
export type NativeResume =
  | { readonly kind: "flag"; readonly flag: string }
  | { readonly kind: "subcommand"; readonly subcommand: string };

/** Where a provider's native CLI persists session files (read-only, for recent-id discovery). */
export interface NativeSessionStore {
  /** Root directory to scan recursively for session files (may include `~`). */
  readonly rootDir: string;
  /** File extension marking a session file. */
  readonly extension: string;
  /** How to derive the native session id from a session file's basename. */
  readonly idFrom: "basename" | "last-uuid";
}

export interface NativeResumeCapability {
  readonly supported: true;
  readonly resume: NativeResume;
  readonly sessionStore: NativeSessionStore;
}
export interface NativeResumeUnsupported {
  readonly supported: false;
}
export type NativeResumeDescriptor = NativeResumeCapability | NativeResumeUnsupported;

// ── Provider profile (pure data) ────────────────────────────────────────

export interface ProviderProfile {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly auth: AuthStrategy;
  readonly models: ModelMapping;
  readonly capabilities: ProviderCapabilities;
  readonly environment: EnvironmentOwnership;
  readonly cliLaunch: CliLaunchDescriptor;
}

// ── CLI launch adapter ──────────────────────────────────────────────────

export interface CliLaunchContext {
  /** Working directory the CLI will be launched in. */
  readonly workingDir: string;
  /** Logical model alias to resolve (defaults to "default"). */
  readonly modelAlias?: string;
  /** Optional project/task identity, when the provider's launch path uses it (e.g. proxy-routed). */
  readonly project?: {
    readonly teamId?: string;
    readonly agentId?: string;
    readonly taskId?: string;
  };
  /**
   * Inject an env-map for resolving launch secrets (e.g. a proxy user key
   * stored in a credential backend), instead of the process environment.
   * Falls back to `process.env` for any var not present here. This is what
   * lets the launcher source deepseek's proxy key from CredentialManager
   * rather than requiring a manual `export`.
   */
  readonly secrets?: Readonly<Record<string, string>>;
  /** When set, resume the provider's native session with this id (builds resume args). */
  readonly resumeNativeSessionId?: string;
}

/** A fully-resolved plan for launching a coding-agent CLI against this provider. */
export interface CliLaunchPlan {
  readonly executable: string;
  readonly args: readonly string[];
  /**
   * Env vars to SET for the launched process. Values here are resolved
   * secrets/config, exactly as the real launcher already sets
   * `$env:ANTHROPIC_AUTH_TOKEN` etc. — expected to hold real values for the
   * child process's own use. Callers must not log or print this object.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Env vars to clear from the inherited shell before launch (leakage prevention). */
  readonly clearEnvVars: readonly string[];
  readonly configDir?: string;
}

// ── Provider adapter (behavior) ─────────────────────────────────────────

/**
 * The behavioral surface CONTINUUM's runtime actually calls. Holds a
 * profile rather than extending it, so profile data stays serializable and
 * adapter behavior stays testable in isolation.
 */
export interface ProviderAdapter {
  readonly profile: ProviderProfile;

  /** Resolve a logical model alias ("default" if omitted) to a real model id. */
  resolveModel(alias?: string): string;

  /**
   * Build auth headers for a DIRECT API call to this provider (used by a
   * native LLMRunner-style caller, not by CLI launching). Resolves secrets
   * internally — the returned headers are the only place a real credential
   * value should ever end up, and only in memory, never logged.
   */
  buildAuthHeaders(): Readonly<Record<string, string>>;

  /** Build a launch plan for routing a coding-agent CLI through this provider. */
  buildCliLaunchPlan(ctx: CliLaunchContext): CliLaunchPlan;

  getCapabilities(): ProviderCapabilities;
}
