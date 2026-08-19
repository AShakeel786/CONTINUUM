/**
 * User provider manifests — the secret-free, JSON-serializable description of
 * a provider that the runtime converts into the existing `ProviderProfile` +
 * `ProviderAuthMetadata` (+ optional `CliAuthAdapter`). This is the Phase 20
 * extensibility boundary: a user adds a `.json` manifest under
 * `~/.continuum/providers/` and CONTINUUM treats it identically to the bundled
 * Claude/DeepSeek/Codex presets — no source edit, no provider-id switch.
 *
 * Manifests are deliberately "profile-shaped but friendlier": `auth` and
 * `cliLaunch` reference secrets by `envVar` string (not the internal
 * `SecretRef` wrapper), and optional fields get sane defaults. Credentials are
 * NEVER stored here — only the env-var *name* that `CredentialManager`
 * resolves at activation time.
 */

import type {
  CliLaunchDescriptor,
  EnvironmentOwnership,
  ModelTierMap,
  NativeResumeDescriptor,
  Protocol,
  ProviderCapabilities,
  ProviderProfile,
  ProxyRoutedCliLaunch,
} from "./types.js";
import { secretRef } from "./secrets.js";
import type { CliAuthCapability, CliAuthCheckEnv, ProviderAuthMetadata } from "../auth/types.js";

export const MANIFEST_SCHEMA_VERSION = 1;

export type ManifestAuth =
  | { readonly kind: "api-key"; readonly envVar: string }
  | { readonly kind: "bearer-token"; readonly envVar: string }
  | { readonly kind: "cli-session" }
  | { readonly kind: "proxy-routed"; readonly envVar: string; readonly proxyBaseUrl: string };

export type ManifestContextDelivery =
  | { readonly kind: "append-system-prompt"; readonly systemFlag: string }
  | { readonly kind: "prompt-only" };

export type ManifestMcpLaunch =
  | { readonly kind: "mcp-config-flag"; readonly flag: string }
  | { readonly kind: "global-config" };

export interface ManifestCliLaunchCommon {
  readonly configDirName?: string;
  readonly clearEnvVars?: readonly string[];
  readonly nativeResume?: NativeResumeDescriptor;
  readonly mcp?: { readonly supported: true; readonly serverName: string } | { readonly supported: false };
  readonly contextDelivery?: ManifestContextDelivery;
  readonly mcpLaunch?: ManifestMcpLaunch;
  readonly statusLineCommand?: string;
}

export type ManifestCliLaunch =
  | (ManifestCliLaunchCommon & {
      readonly kind: "native";
      /** Verified native flag that selects the model at launch (Codex `-m`, agy `--model`). */
      readonly modelFlag?: string;
      /** Verified native flag that skips all permission approvals (agy `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`). */
      readonly permissionBypassFlag?: string;
    })
  | (ManifestCliLaunchCommon & {
      readonly kind: "redirected";
      readonly baseUrl: string;
      readonly authTokenEnvVar: string;
      /** Maps Claude Code's internal model tiers to this provider's own models (see `ModelTierMap`). */
      readonly modelTierMap?: ModelTierMap;
    })
  | (ManifestCliLaunchCommon & {
      readonly kind: "proxy-routed";
      readonly proxyBaseUrl: string;
      readonly proxyPathSuffix: string;
      readonly proxyUserKeyEnvVar: string;
      /** Maps Claude Code's internal model tiers to this provider's own models (see `ModelTierMap`). */
      readonly modelTierMap?: ModelTierMap;
    });

/**
 * The optional proxy-routed launch descriptor for dual-route providers
 * (DeepSeek). Declared separately from `cliLaunch` (the default/direct path)
 * so a provider can offer a remote-direct launch by default while keeping the
 * optional Tencent MemoryProxy route available behind explicit opt-in.
 */
export type ManifestProxyCliLaunch = ManifestCliLaunchCommon & {
  readonly kind: "proxy-routed";
  readonly proxyBaseUrl: string;
  readonly proxyPathSuffix: string;
  readonly proxyUserKeyEnvVar: string;
  /** Maps Claude Code's internal model tiers to this provider's own models (see `ModelTierMap`). */
  readonly modelTierMap?: ModelTierMap;
};

export interface ManifestCli {
  readonly supported: true;
  readonly executable: string;
  readonly versionArgs: readonly string[];
  readonly statusArgs?: readonly string[];
  readonly loginArgs: readonly string[];
  readonly logoutArgs?: readonly string[];
}

export interface ManifestProxyUserKey {
  readonly envVar: string;
  readonly credentialName?: string;
}

export interface ManifestCapabilities {
  readonly thinking?: "none" | "supported" | "extended";
  readonly tools?: boolean;
  readonly promptCache?: "none" | "anthropic-explicit" | "openai-automatic";
  readonly contextWindowTokens?: number;
  readonly cliAvailable?: boolean;
  readonly notes?: string;
}

export interface ProviderManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly auth: ManifestAuth;
  readonly models: { readonly default: string; readonly aliases?: Readonly<Record<string, string>> };
  readonly capabilities?: ManifestCapabilities;
  readonly environment?: EnvironmentOwnership;
  readonly cliLaunch?: ManifestCliLaunch;
  /** Optional alternative proxy-routed launch descriptor (see `ManifestProxyCliLaunch`). */
  readonly proxyCliLaunch?: ManifestProxyCliLaunch;
  readonly cli?: ManifestCli;
  readonly proxyUserKey?: ManifestProxyUserKey;
  /** Default launch permission mode when the caller specifies none ("safe" = approvals, "bypass" = full access). */
  readonly defaultPermissionMode?: "safe" | "bypass";
  /** Live model-list discovery from the installed CLI (see types.ts `ModelDiscovery`). */
  readonly modelDiscovery?: import("./types.js").ModelDiscovery;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a parsed manifest; returns all errors (empty = valid). */
export function validateManifest(input: unknown): readonly string[] {
  const errors: string[] = [];
  const m = input as Partial<ProviderManifest>;
  if (typeof input !== "object" || input === null) return ["manifest must be a JSON object"];

  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) errors.push("id must match /^[a-z0-9][a-z0-9-]{0,63}$/");
  if (typeof m.displayName !== "string" || m.displayName.trim().length === 0) errors.push("displayName is required");
  if (m.protocol !== "openai-compatible" && m.protocol !== "anthropic-messages") errors.push("protocol must be openai-compatible or anthropic-messages");

  // baseUrl must be a valid http(s) URL.
  if (typeof m.baseUrl !== "string" || !/^https?:\/\/[^\s]+$/.test(m.baseUrl.trim())) errors.push("baseUrl must be a valid http(s) URL");

  const auth = m.auth as Partial<ManifestAuth> | undefined;
  if (!auth) errors.push("auth is required");
  else {
    const kinds = ["api-key", "bearer-token", "cli-session", "proxy-routed"];
    if (!kinds.includes(auth.kind as string)) errors.push(`auth.kind must be one of ${kinds.join(", ")}`);
    if ((auth.kind === "api-key" || auth.kind === "bearer-token") && (!auth.envVar || typeof auth.envVar !== "string")) {
      errors.push(`auth.envVar is required for auth.kind=${auth.kind}`);
    }
    if (auth.kind === "proxy-routed" && (!auth.envVar || !auth.proxyBaseUrl)) {
      errors.push("auth.envVar and auth.proxyBaseUrl are required for proxy-routed");
    }
  }

  if (!m.models || typeof m.models.default !== "string" || m.models.default.trim().length === 0) {
    errors.push("models.default is required");
  }

  const caps = m.capabilities;
  if (caps) {
    if (caps.thinking !== undefined && !["none", "supported", "extended"].includes(caps.thinking)) errors.push("capabilities.thinking invalid");
    if (caps.promptCache !== undefined && !["none", "anthropic-explicit", "openai-automatic"].includes(caps.promptCache)) errors.push("capabilities.promptCache invalid");
    if (caps.contextWindowTokens !== undefined && (typeof caps.contextWindowTokens !== "number" || caps.contextWindowTokens <= 0)) errors.push("capabilities.contextWindowTokens must be positive");
  }

  if (m.defaultPermissionMode !== undefined && m.defaultPermissionMode !== "safe" && m.defaultPermissionMode !== "bypass") {
    errors.push("defaultPermissionMode must be \"safe\" or \"bypass\"");
  }

  const modelDiscovery = m.modelDiscovery;
  if (modelDiscovery) {
    if (modelDiscovery.kind !== "cli-command" && modelDiscovery.kind !== "json-cache") {
      errors.push("modelDiscovery.kind must be cli-command or json-cache");
    }
    if (modelDiscovery.kind === "cli-command" && (!Array.isArray(modelDiscovery.command) || modelDiscovery.command.length === 0)) {
      errors.push("modelDiscovery.command must be a non-empty string array for kind=cli-command");
    }
    if (modelDiscovery.kind === "json-cache" && (typeof modelDiscovery.path !== "string" || modelDiscovery.path.trim().length === 0)) {
      errors.push("modelDiscovery.path is required for kind=json-cache");
    }
  }

  const cli = m.cli;
  if (cli) {
    if (cli.supported !== true) errors.push("cli.supported must be true when a cli block is present");
    if (typeof cli.executable !== "string" || cli.executable.trim().length === 0) errors.push("cli.executable is required");
    if (!Array.isArray(cli.loginArgs) || cli.loginArgs.length === 0) errors.push("cli.loginArgs is required");
  }

  // Structural validation for the (new) dual-route launch descriptors.
  const launch = m.cliLaunch;
  if (launch && launch.kind === "redirected") {
    if (typeof launch.baseUrl !== "string" || !/^https?:\/\/[^\s]+$/.test(launch.baseUrl.trim())) {
      errors.push("cliLaunch.baseUrl must be a valid http(s) URL for kind=redirected");
    }
    if (typeof launch.authTokenEnvVar !== "string" || launch.authTokenEnvVar.trim().length === 0) {
      errors.push("cliLaunch.authTokenEnvVar is required for kind=redirected");
    }
  }
  const proxyLaunch = m.proxyCliLaunch;
  if (proxyLaunch) {
    if (proxyLaunch.kind !== "proxy-routed") errors.push("proxyCliLaunch.kind must be proxy-routed");
    if (typeof proxyLaunch.proxyBaseUrl !== "string" || proxyLaunch.proxyBaseUrl.trim().length === 0) errors.push("proxyCliLaunch.proxyBaseUrl is required");
    if (typeof proxyLaunch.proxyUserKeyEnvVar !== "string" || proxyLaunch.proxyUserKeyEnvVar.trim().length === 0) {
      errors.push("proxyCliLaunch.proxyUserKeyEnvVar is required");
    }
  }

  // Safety: reject anything that looks like an inline secret in a manifest field.
  const serialized = JSON.stringify(input);
  if (/sk-[a-zA-Z0-9_-]{8,}|AKID[a-zA-Z0-9]{8,}|-----BEGIN/i.test(serialized)) {
    errors.push("manifest must not contain a secret value (use an envVar name, never a key)");
  }

  return errors;
}

function toCapabilities(m: ProviderManifest): ProviderCapabilities {
  const c = m.capabilities ?? {};
  const protocol = m.protocol;
  return {
    protocol,
    thinking: c.thinking ?? "supported",
    tools: c.tools ?? true,
    promptCache: c.promptCache ?? (protocol === "anthropic-messages" ? "anthropic-explicit" : "openai-automatic"),
    // A provider is CLI-launchable only when it declares a real CLI (or says so
    // explicitly); an API-only provider (Grok/GLM) is direct-API only.
    cliAvailable: c.cliAvailable ?? (m.cli?.supported === true),
    ...(c.contextWindowTokens !== undefined ? { contextWindowTokens: c.contextWindowTokens } : {}),
    ...(c.notes !== undefined ? { notes: c.notes } : {}),
  };
}

function toCliLaunch(m: ProviderManifest): CliLaunchDescriptor {
  const l = m.cliLaunch ?? { kind: "native" as const };
  if (l.kind === "native") {
    return {
      kind: "native",
      executable: m.cli?.executable ?? m.id,
      ...(l.configDirName ? { configDirName: l.configDirName } : {}),
      ...(l.modelFlag ? { modelFlag: l.modelFlag } : {}),
      ...(l.permissionBypassFlag ? { permissionBypassFlag: l.permissionBypassFlag } : {}),
      clearEnvVars: l.clearEnvVars ?? [],
      ...(l.nativeResume ? { nativeResume: l.nativeResume } : {}),
      ...(l.mcp ? { mcp: l.mcp } : {}),
      ...(l.contextDelivery ? { contextDelivery: l.contextDelivery } : {}),
      ...(l.mcpLaunch ? { mcpLaunch: l.mcpLaunch } : {}),
      ...(l.statusLineCommand ? { statusLineCommand: l.statusLineCommand } : {}),
    };
  }
  if (l.kind === "redirected") {
    return {
      kind: "redirected",
      executable: m.cli?.executable ?? "claude",
      configDirName: l.configDirName ?? ".claude",
      baseUrl: l.baseUrl,
      authTokenSecret: secretRef(l.authTokenEnvVar),
      clearEnvVars: l.clearEnvVars ?? [],
      ...(l.nativeResume ? { nativeResume: l.nativeResume } : {}),
      ...(l.mcp ? { mcp: l.mcp } : {}),
      ...(l.contextDelivery ? { contextDelivery: l.contextDelivery } : {}),
      ...(l.mcpLaunch ? { mcpLaunch: l.mcpLaunch } : {}),
      ...(l.statusLineCommand ? { statusLineCommand: l.statusLineCommand } : {}),
      ...(l.modelTierMap ? { modelTierMap: l.modelTierMap } : {}),
    };
  }
  return {
    kind: "proxy-routed",
    executable: m.cli?.executable ?? "claude",
    configDirName: l.configDirName ?? ".claude",
    proxyBaseUrl: l.proxyBaseUrl,
    proxyPathSuffix: l.proxyPathSuffix,
    proxyUserKeySecret: secretRef(l.proxyUserKeyEnvVar),
    clearEnvVars: l.clearEnvVars ?? [],
    ...(l.nativeResume ? { nativeResume: l.nativeResume } : {}),
    ...(l.mcp ? { mcp: l.mcp } : {}),
    ...(l.contextDelivery ? { contextDelivery: l.contextDelivery } : {}),
    ...(l.mcpLaunch ? { mcpLaunch: l.mcpLaunch } : {}),
    ...(l.statusLineCommand ? { statusLineCommand: l.statusLineCommand } : {}),
    ...(l.modelTierMap ? { modelTierMap: l.modelTierMap } : {}),
  };
}

/** Convert the optional proxy-routed launch descriptor into the runtime shape. */
function toProxyCliLaunch(m: ProviderManifest): ProxyRoutedCliLaunch | undefined {
  const l = m.proxyCliLaunch;
  if (!l) return undefined;
  return {
    kind: "proxy-routed",
    executable: m.cli?.executable ?? "claude",
    configDirName: l.configDirName ?? ".claude",
    proxyBaseUrl: l.proxyBaseUrl,
    proxyPathSuffix: l.proxyPathSuffix,
    proxyUserKeySecret: secretRef(l.proxyUserKeyEnvVar),
    clearEnvVars: l.clearEnvVars ?? [],
    ...(l.nativeResume ? { nativeResume: l.nativeResume } : {}),
    ...(l.mcp ? { mcp: l.mcp } : {}),
    ...(l.contextDelivery ? { contextDelivery: l.contextDelivery } : {}),
    ...(l.mcpLaunch ? { mcpLaunch: l.mcpLaunch } : {}),
    ...(l.statusLineCommand ? { statusLineCommand: l.statusLineCommand } : {}),
    ...(l.modelTierMap ? { modelTierMap: l.modelTierMap } : {}),
  };
}

/** Convert a validated manifest into a runtime `ProviderProfile`. */
export function manifestToProfile(m: ProviderManifest): ProviderProfile {
  const auth = m.auth;
  const proxyCliLaunch = toProxyCliLaunch(m);
  return {
    id: m.id,
    displayName: m.displayName,
    protocol: m.protocol,
    baseUrl: m.baseUrl,
    auth:
      auth.kind === "api-key"
        ? { kind: "api-key", secret: secretRef(auth.envVar) }
        : auth.kind === "bearer-token"
          ? { kind: "bearer-token", secret: secretRef(auth.envVar) }
          : auth.kind === "proxy-routed"
            ? { kind: "proxy-routed", secret: secretRef(auth.envVar), proxyBaseUrl: auth.proxyBaseUrl }
            : { kind: "cli-session", note: `${m.displayName} authenticates via its own native CLI session.` },
    models: { default: m.models.default, aliases: m.models.aliases ?? {} },
    capabilities: toCapabilities(m),
    environment: m.environment ?? { owns: envOwns(m) },
    cliLaunch: toCliLaunch(m),
    ...(m.defaultPermissionMode ? { defaultPermissionMode: m.defaultPermissionMode } : {}),
    ...(m.modelDiscovery ? { modelDiscovery: m.modelDiscovery } : {}),
    ...(proxyCliLaunch ? { proxyCliLaunch } : {}),
  };
}

function envOwns(m: ProviderManifest): readonly string[] {
  const owns = new Set<string>();
  const a = m.auth;
  if ((a.kind === "api-key" || a.kind === "bearer-token" || a.kind === "proxy-routed") && a.envVar) owns.add(a.envVar);
  if (m.proxyUserKey?.envVar) owns.add(m.proxyUserKey.envVar);
  // Dual-route providers declare their redirect/proxy env vars on the launch
  // descriptors, not the auth block — capture them so a launcher can clear
  // exactly what the provider owns and never leave a stale proxy var set.
  if (m.cliLaunch?.kind === "redirected") owns.add(m.cliLaunch.authTokenEnvVar);
  if (m.proxyCliLaunch?.kind === "proxy-routed") owns.add(m.proxyCliLaunch.proxyUserKeyEnvVar);
  return [...owns];
}

/**
 * Auth-check isolation for native Claude-family CLIs that read their login from
 * a `CLAUDE_CONFIG_DIR`. Only a *native* CLI with a declared `configDirName`
 * gets this — proxy-routed providers (DeepSeek) and config-dir-less CLIs
 * (Codex) keep the ambient env, which is their correct behavior.
 */
function toCliAuthCheckEnv(m: ProviderManifest): CliAuthCheckEnv | undefined {
  const launch = m.cliLaunch;
  if (!launch || launch.kind !== "native" || !launch.configDirName) return undefined;
  const clearEnvVars = [...new Set([...(launch.clearEnvVars ?? []), "CLAUDE_CODE_SIMPLE"])];
  return { configDirName: launch.configDirName, clearEnvVars };
}

/** Convert a validated manifest into `ProviderAuthMetadata`. */
export function manifestToAuthMetadata(m: ProviderManifest): ProviderAuthMetadata {
  const api =
    m.auth.kind === "api-key" || m.auth.kind === "bearer-token"
      ? { supported: true as const, envVar: m.auth.envVar! }
      : { supported: false as const };

  const authEnv = toCliAuthCheckEnv(m);
  const cli: ProviderAuthMetadata["cli"] = m.cli
    ? {
        supported: true,
        executable: m.cli.executable,
        versionArgs: m.cli.versionArgs,
        ...(m.cli.statusArgs ? { statusArgs: m.cli.statusArgs } : {}),
        loginArgs: m.cli.loginArgs,
        ...(m.cli.logoutArgs ? { logoutArgs: m.cli.logoutArgs } : {}),
        ...(authEnv ? { authEnv } : {}),
      }
    : { supported: false };

  return {
    providerId: m.id,
    api,
    cli,
    ...(m.proxyUserKey
      ? { proxyUserKey: { supported: true, envVar: m.proxyUserKey.envVar, credentialName: m.proxyUserKey.credentialName ?? "proxy-user-key" } }
      : {}),
  };
}

/** Convert a validated manifest into a `CliAuthCapability` (undefined when no CLI auth). */
export function manifestToCliAuthCapability(m: ProviderManifest): CliAuthCapability | undefined {
  if (!m.cli) return undefined;
  const authEnv = toCliAuthCheckEnv(m);
  return {
    supported: true,
    executable: m.cli.executable,
    versionArgs: m.cli.versionArgs,
    ...(m.cli.statusArgs ? { statusArgs: m.cli.statusArgs } : {}),
    loginArgs: m.cli.loginArgs,
    ...(m.cli.logoutArgs ? { logoutArgs: m.cli.logoutArgs } : {}),
    ...(authEnv ? { authEnv } : {}),
  };
}
