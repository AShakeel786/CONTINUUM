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

// ── Promotional availability ────────────────────────────────────────────

/**
 * A temporary/limited-time promotional state (e.g. "free preview").
 * `until` is OPTIONAL and only ever carries an authoritative end timestamp
 * from the upstream source — when the exact end date is unknown it is
 * omitted rather than guessed, and the promo reads as "limited time".
 * Automatic preference routing never depends on a guessed date: it follows
 * current provider usability (plus `until`, only when one was authoritatively
 * declared). An expired promo is no longer advertised or auto-preferred, but
 * the provider remains explicitly selectable (it may simply become paid).
 */
export interface PromoInfo {
  /** Authoritative end timestamp (ISO) — optional; omit when the exact end date is not known. */
  readonly until?: string;
  readonly note: string;
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

// ── Native context delivery (data, not behavior) ─────────────────────────
//
// How a native coding-agent CLI receives the assembled CONTINUUM context
// (task objective + session-maintenance + handoff/resume state + repo map +
// recalled memory). Declared on the profile so the adapter renders the
// context into the CLI's own injection surface without switching on provider
// id. This is the missing half the dogfood audit found: `prepareLaunch` built
// the rendered context but discarded it for every native CLI launch.

/**
 * Claude Code family (native Claude + DeepSeek-proxy-routed): the task goal is
 * the positional prompt, and the compact instructions/context are appended
 * via a real, verified system-prompt flag (`claude --append-system-prompt`).
 */
export interface AppendSystemPromptDelivery {
  readonly kind: "append-system-prompt";
  /** The verified CLI flag that appends a system prompt (e.g. `--append-system-prompt`). */
  readonly systemFlag: string;
}

/**
 * Codex: the CLI has no `--system-prompt` flag. Everything — compact
 * instructions/context followed by the task goal — is folded into the single
 * positional `[PROMPT]`. On resume the prompt is appended after
 * `resume <session_id>`.
 */
export interface PromptOnlyDelivery {
  readonly kind: "prompt-only";
}

export type ContextDelivery = AppendSystemPromptDelivery | PromptOnlyDelivery;

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
   * Native flag that explicitly selects the model at launch (verified: Codex
   * `-m`, agy `--model`). Declared only where the CLI honors an explicit
   * model flag; the adapter emits `[modelFlag, <resolved model id>]` on BOTH
   * fresh and resume launches so an explicitly selected model always reaches
   * the CLI. Absent (Claude/DeepSeek) = the CLI uses its own default/identity,
   * preserving existing behavior.
   */
  readonly modelFlag?: string;
  /**
   * Native flag that launches with all tool permission approvals skipped
   * (verified: agy `--dangerously-skip-permissions`, Codex
   * `--dangerously-bypass-approvals-and-sandbox`). Emitted only when the
   * caller requests `permissionMode: "bypass"`; absent = full-access is
   * unsupported for this provider (the launcher then warns rather than
   * silently running safe). Never emulated via shell tricks or config edits.
   */
  readonly permissionBypassFlag?: string;
  /**
   * Env vars to clear before launch, in case a previous session (a
   * different provider, or a different agent system entirely) left them
   * set and would otherwise silently redirect this one. Mirrors the real
   * Tencent launcher's env-sanitization-before-launch pattern.
   */
  readonly clearEnvVars: readonly string[];
  /** Native-session resume capability (declared as data — see below). */
  readonly nativeResume?: NativeResumeDescriptor;
  /** MCP auto-connect capability (declared as data — see below). */
  readonly mcp?: McpRegistrationDescriptor;
  /** How the CLI receives task + assembled context (declared as data). */
  readonly contextDelivery?: ContextDelivery;
  /** How the CLI receives the CONTINUUM MCP server config at launch (declared as data). */
  readonly mcpLaunch?: McpLaunchSupply;
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
  /** Optional supported Claude Code statusline command. */
  readonly statusLineCommand?: string;
  /** Native-session resume capability (declared as data — see below). */
  readonly nativeResume?: NativeResumeDescriptor;
  /** MCP auto-connect capability (declared as data — see below). */
  readonly mcp?: McpRegistrationDescriptor;
  /** How the CLI receives task + assembled context (declared as data). */
  readonly contextDelivery?: ContextDelivery;
  /** How the CLI receives the CONTINUUM MCP server config at launch (declared as data). */
  readonly mcpLaunch?: McpLaunchSupply;
  /** Maps Claude Code's internal model tiers to this provider's own models (see `ModelTierMap` below). */
  readonly modelTierMap?: ModelTierMap;
}

/**
 * Launch the CLI redirected to a REMOTE Anthropic-compatible endpoint by
 * setting `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` — the same mechanism
 * as proxy-routed, but pointing at a real upstream (e.g. DeepSeek's
 * `https://api.deepseek.com/anthropic`) with the provider's OWN API key rather
 * than a local proxy's user key. This is the direct DeepSeek path that needs
 * no Docker/Tencent/MemoryProxy: CONTINUUM reaches DeepSeek straight through
 * its own Anthropic-compatible endpoint.
 */
export interface RedirectedCliLaunch {
  readonly kind: "redirected";
  readonly executable: string;
  readonly configDirName: string;
  /** Full base URL the CLI is redirected to (includes any path suffix). */
  readonly baseUrl: string;
  /** Secret resolved as `ANTHROPIC_AUTH_TOKEN` (the upstream API key). */
  readonly authTokenSecret: SecretRef;
  readonly clearEnvVars: readonly string[];
  /** Optional supported Claude Code statusline command. */
  readonly statusLineCommand?: string;
  /** Native-session resume capability (declared as data — see below). */
  readonly nativeResume?: NativeResumeDescriptor;
  /** MCP auto-connect capability (declared as data — see below). */
  readonly mcp?: McpRegistrationDescriptor;
  /** How the CLI receives task + assembled context (declared as data). */
  readonly contextDelivery?: ContextDelivery;
  /** How the CLI receives the CONTINUUM MCP server config at launch (declared as data). */
  readonly mcpLaunch?: McpLaunchSupply;
  /** Maps Claude Code's internal model tiers to this provider's own models (see `ModelTierMap` below). */
  readonly modelTierMap?: ModelTierMap;
}

// ── Model tier identity (data, not behavior) ────────────────────────────
//
// Claude Code (the binary) has its own internal notion of "opus"/"sonnet"/
// "haiku" tiers plus a subagent default, used both for its visible
// current-model label and for internal calls (subagents, background
// classifiers) it makes on its own. When a `redirected`/`proxy-routed`
// launch points that same binary at a third-party endpoint, those internal
// references still default to Anthropic's own model names unless told
// otherwise — which is how a DeepSeek session can visibly show "Opus 5"
// while actually talking to DeepSeek. `modelTierMap` maps each Claude Code
// tier to one of THIS provider's own `models.default`/`models.aliases`
// entries (resolved through the same `resolveModel` every other model
// reference uses), so the mapping is data, never a hardcoded model string.

export interface ModelTierMap {
  /** Alias resolved for `ANTHROPIC_DEFAULT_OPUS_MODEL` ("default" or a `models.aliases` key). */
  readonly opus?: string;
  /** Alias resolved for `ANTHROPIC_DEFAULT_SONNET_MODEL`. */
  readonly sonnet?: string;
  /** Alias resolved for `ANTHROPIC_DEFAULT_HAIKU_MODEL`. */
  readonly haiku?: string;
  /** Alias resolved for `CLAUDE_CODE_SUBAGENT_MODEL`. */
  readonly subagent?: string;
}

export type CliLaunchDescriptor = NativeCliLaunch | ProxyRoutedCliLaunch | RedirectedCliLaunch;

// ── Model discovery (data, not behavior) ────────────────────────────────
//
// How to discover the provider's CURRENT model list from the installed CLI,
// so CONTINUUM exposes exactly what the authenticated CLI supports instead of
// a hardcoded (and drifting) list. Two reliable, local mechanisms exist:
//   - cli-command — a real subcommand that prints the model list (agy `models`).
//   - json-cache  — a JSON cache file the CLI itself maintains (~/.codex/models_cache.json).
// Absent = no live discovery (manifest models only). Discovery is read-only
// and best-effort; any failure degrades to the manifest models, never errors.

export type ModelDiscovery =
  | { readonly kind: "cli-command"; readonly command: readonly string[] }
  | { readonly kind: "json-cache"; readonly path: string };

/** Which launch descriptor a dual-route provider (DeepSeek) uses this run. */
export type LaunchRoute = "direct" | "proxy";

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

/**
 * Where a provider's native CLI persists session files (read-only, for
 * recent-id discovery). Two storage kinds, discriminated by `kind`:
 *   - "files"  — a directory of session files (Claude `<uuid>.jsonl`, Codex
 *     `rollout-…-<uuid>.jsonl`), discovered by filename + mtime.
 *   - "sqlite" — a SQLite index table holding conversation ids + recency
 *     (Antigravity's `conversation_summaries.db`), discovered by a single
 *     ORDER BY query. No provider id is ever switched on here.
 */
export type NativeSessionStore = NativeFileSessionStore | NativeSqliteSessionStore;

/** File-based session store (Claude/DeepSeek/Codex). */
export interface NativeFileSessionStore {
  readonly kind: "files";
  /** Root directory to scan recursively for session files (may include `~`). */
  readonly rootDir: string;
  /** File extension marking a session file. */
  readonly extension: string;
  /**
   * How to derive the native session id:
   *   - "basename": filename minus extension (Claude's `<uuid>.jsonl`).
   *   - "last-uuid": trailing UUID in the filename (Codex's `rollout-…-<uuid>`).
   *   - "session-meta": read the canonical id from a JSONL record's payload
   *     (proven for Codex: `payload.session_id`), falling back to last-uuid.
   */
  readonly idFrom: "basename" | "last-uuid" | "session-meta";
  /** For idFrom "session-meta": the JSONL record `type` holding the canonical id. */
  readonly metaRecordType?: string;
  /** For idFrom "session-meta": the payload field holding the canonical id. */
  readonly metaPayloadField?: string;
}

/**
 * SQLite session store (Antigravity). The provider's own session index is a
 * SQLite table; the most-recent conversation id is the single row with the
 * greatest recency column. Read-only and best-effort: any read failure yields
 * `undefined` (the launcher then falls back to the resume brief).
 */
export interface NativeSqliteSessionStore {
  readonly kind: "sqlite";
  /** Path to the SQLite database file (may include `~`). */
  readonly dbPath: string;
  /** Table holding one row per conversation. */
  readonly table: string;
  /** Column holding the stable conversation id accepted by the resume flag. */
  readonly idColumn: string;
  /** Column used for recency ordering (lexicographically sortable datetime). */
  readonly mtimeColumn: string;
}

export interface NativeResumeCapability {
  readonly supported: true;
  readonly resume: NativeResume;
  readonly sessionStore: NativeSessionStore;
  /**
   * When the CLI supports setting a new session's id explicitly (e.g. Claude
   * Code `--session-id <uuid>`), the flag to use for a deterministic native
   * session id. Absent = the CLI generates its own id (Codex) → store-scan.
   */
  readonly sessionIdFlag?: string;
}
export interface NativeResumeUnsupported {
  readonly supported: false;
}
export type NativeResumeDescriptor = NativeResumeCapability | NativeResumeUnsupported;

// ── MCP auto-connect (data, not behavior) ─────────────────────────────────
//
// A provider whose CLI can register an external MCP server declares that the
// CONTINUUM `continuum-mcp` stdio server may be auto-registered for it. The
// registration command shape is identical across Claude and Codex
// (`<cli> mcp add <name> -- <command>...`), so this is just a capability flag
// + server name, never a provider-id switch.

export interface McpRegistrationCapability {
  readonly supported: true;
  /** MCP server name used in `<cli> mcp add <name> ...`. */
  readonly serverName: string;
}
export interface McpRegistrationUnsupported {
  readonly supported: false;
}
export type McpRegistrationDescriptor = McpRegistrationCapability | McpRegistrationUnsupported;

// ── MCP launch supply (data, not behavior) ────────────────────────────────
//
// How a native CLI receives the CONTINUUM `continuum-mcp` server config at
// launch time, so `session_update`/`session_state` are available in BOTH
// interactive and headless/SDK modes. Claude-family CLIs load project-scoped
// MCP only when trusted interactively — in SDK/headless mode they skip it —
// so they must be handed the server explicitly via a real, verified flag.
// Codex reads its own global `~/.codex/config.toml` (registered there), so it
// needs no launch flag.

/** Claude Code family: pass the server config explicitly via `--mcp-config <json>`. */
export interface McpLaunchFlagSupply {
  readonly kind: "mcp-config-flag";
  /** The verified CLI flag that loads MCP servers (e.g. `--mcp-config`). */
  readonly flag: string;
}

/** Codex: MCP is read from the CLI's own global config; no launch flag needed. */
export interface McpLaunchGlobalSupply {
  readonly kind: "global-config";
}

export type McpLaunchSupply = McpLaunchFlagSupply | McpLaunchGlobalSupply;

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
  /**
   * Default launch permission mode when the caller does not specify one
   * (`"safe"` = normal approval prompts, `"bypass"` = full access with every
   * tool approval skipped via the profile's native bypass flag). Absent →
   * `"safe"`. Declared per provider so Codex/Antigravity default to full
   * access while Claude/DeepSeek keep the safe default. An explicit caller
   * choice always overrides this.
   */
  readonly defaultPermissionMode?: "safe" | "bypass";
  /** Live model-list discovery from the installed CLI (see `ModelDiscovery`). Absent = manifest models only. */
  readonly modelDiscovery?: ModelDiscovery;
  /**
   * Optional alternative proxy-routed launch descriptor for providers that
   * support BOTH a direct remote endpoint and an optional local proxy
   * (DeepSeek's optional Tencent MemoryProxy mode). Absent for providers
   * with a single launch path. Selected at runtime via `route: "proxy"`.
   */
  readonly proxyCliLaunch?: ProxyRoutedCliLaunch;
  /** Optional temporary/promotional state (e.g. limited-time free). See `PromoInfo`. */
  readonly promo?: PromoInfo;
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
  /** When set (and the provider declares a `sessionIdFlag`), set a deterministic native session id for a fresh launch. */
  readonly setSessionId?: string;
  /**
   * The task objective, delivered as the CLI's prompt argument (or folded into
   * it, per the profile's `contextDelivery`). Secret-free session goal text.
   */
  readonly taskPrompt?: string;
  /**
   * The compact, already-budgeted CONTINUUM context (session-maintenance +
   * handoff/resume + repo map + recalled memory), delivered per the profile's
   * `contextDelivery` mechanism. Secret-free by construction.
   */
  readonly contextSystem?: string;
  /**
   * Secret-free MCP server config (JSON) to hand the CLI via its declared
   * `mcpLaunch` flag, e.g. `{"mcpServers":{"continuum":{...}}}`. Generated by
   * the launcher from the existing `continuum-mcp` server command — never a
   * literal credential.
   */
  readonly mcpConfig?: string;
  /**
   * For dual-route providers (DeepSeek): which launch descriptor to use.
   * "proxy" selects the profile's `proxyCliLaunch` (optional Tencent mode);
   * anything else (or absent) uses the primary `cliLaunch` (direct mode).
   */
  readonly route?: LaunchRoute;
  /**
   * "bypass" emits the profile's declared native full-access flag (agy
   * `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-
   * and-sandbox`); "safe" (the default when absent) keeps normal approval
   * prompts. The launcher resolves explicit caller choice > provider default
   * > safe before building the plan.
   */
  readonly permissionMode?: "safe" | "bypass";
  /**
   * Model ids the installed CLI currently supports (from the profile's
   * `modelDiscovery`), so a live model id (e.g. `gemini-3.6-flash-high`)
   * resolves through `resolveModel` without the manifest-alias check while
   * typos of *aliases* still fail loudly.
   */
  readonly knownModelIds?: ReadonlySet<string>;
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

  /**
   * Resolve a logical model alias ("default" if omitted) to a real model id.
   * `knownIds` (the installed CLI's live model ids, from `modelDiscovery`)
   * additionally accepts any exact id in that set, so a live-discovered model
   * passes through while unknown aliases still throw `UnknownModelAliasError`.
   */
  resolveModel(alias?: string, knownIds?: ReadonlySet<string>): string;

  /**
   * Resolve which launch descriptor this provider uses for a given route.
   * "proxy" returns `profile.proxyCliLaunch` when the provider declares one;
   * otherwise (or when absent) the primary `profile.cliLaunch` is returned.
   */
  resolveCliLaunch(route?: LaunchRoute): CliLaunchDescriptor;

  /**
   * Build auth headers for a DIRECT API call to this provider (used by a
   * native LLMRunner-style caller, not by CLI launching). Resolves secrets
   * internally — the returned headers are the only place a real credential
   * value should ever end up, and only in memory, never logged. `env`
   * overrides `process.env` as the secret-resolution source (the launcher
   * passes the launch plan's resolved env so a credential from the OS store
   * reaches the in-process API runner).
   */
  buildAuthHeaders(env?: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>>;

  /** Build a launch plan for routing a coding-agent CLI through this provider. */
  buildCliLaunchPlan(ctx: CliLaunchContext): CliLaunchPlan;

  getCapabilities(): ProviderCapabilities;
}
