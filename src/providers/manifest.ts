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
  NativeResumeDescriptor,
  Protocol,
  ProviderCapabilities,
  ProviderProfile,
} from "./types.js";
import { secretRef } from "./secrets.js";
import type { CliAuthCapability, ProviderAuthMetadata } from "../auth/types.js";

export const MANIFEST_SCHEMA_VERSION = 1;

export type ManifestAuth =
  | { readonly kind: "api-key"; readonly envVar: string }
  | { readonly kind: "bearer-token"; readonly envVar: string }
  | { readonly kind: "cli-session" }
  | { readonly kind: "proxy-routed"; readonly envVar: string; readonly proxyBaseUrl: string };

export type ManifestCliLaunch =
  | {
      readonly kind: "native";
      readonly configDirName?: string;
      readonly clearEnvVars?: readonly string[];
      readonly nativeResume?: NativeResumeDescriptor;
      readonly mcp?: { readonly supported: true; readonly serverName: string } | { readonly supported: false };
    }
  | {
      readonly kind: "proxy-routed";
      readonly proxyBaseUrl: string;
      readonly proxyPathSuffix: string;
      readonly proxyUserKeyEnvVar: string;
      readonly configDirName?: string;
      readonly clearEnvVars?: readonly string[];
      readonly nativeResume?: NativeResumeDescriptor;
      readonly mcp?: { readonly supported: true; readonly serverName: string } | { readonly supported: false };
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
  readonly cli?: ManifestCli;
  readonly proxyUserKey?: ManifestProxyUserKey;
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

  const cli = m.cli;
  if (cli) {
    if (cli.supported !== true) errors.push("cli.supported must be true when a cli block is present");
    if (typeof cli.executable !== "string" || cli.executable.trim().length === 0) errors.push("cli.executable is required");
    if (!Array.isArray(cli.loginArgs) || cli.loginArgs.length === 0) errors.push("cli.loginArgs is required");
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
      clearEnvVars: l.clearEnvVars ?? [],
      ...(l.nativeResume ? { nativeResume: l.nativeResume } : {}),
      ...(l.mcp ? { mcp: l.mcp } : {}),
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
  };
}

/** Convert a validated manifest into a runtime `ProviderProfile`. */
export function manifestToProfile(m: ProviderManifest): ProviderProfile {
  const auth = m.auth;
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
  };
}

function envOwns(m: ProviderManifest): readonly string[] {
  const owns = new Set<string>();
  const a = m.auth;
  if ((a.kind === "api-key" || a.kind === "bearer-token" || a.kind === "proxy-routed") && a.envVar) owns.add(a.envVar);
  if (m.proxyUserKey?.envVar) owns.add(m.proxyUserKey.envVar);
  return [...owns];
}

/** Convert a validated manifest into `ProviderAuthMetadata`. */
export function manifestToAuthMetadata(m: ProviderManifest): ProviderAuthMetadata {
  const api =
    m.auth.kind === "api-key" || m.auth.kind === "bearer-token"
      ? { supported: true as const, envVar: m.auth.envVar! }
      : { supported: false as const };

  const cli: ProviderAuthMetadata["cli"] = m.cli
    ? {
        supported: true,
        executable: m.cli.executable,
        versionArgs: m.cli.versionArgs,
        ...(m.cli.statusArgs ? { statusArgs: m.cli.statusArgs } : {}),
        loginArgs: m.cli.loginArgs,
        ...(m.cli.logoutArgs ? { logoutArgs: m.cli.logoutArgs } : {}),
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
  return {
    supported: true,
    executable: m.cli.executable,
    versionArgs: m.cli.versionArgs,
    ...(m.cli.statusArgs ? { statusArgs: m.cli.statusArgs } : {}),
    loginArgs: m.cli.loginArgs,
    ...(m.cli.logoutArgs ? { logoutArgs: m.cli.logoutArgs } : {}),
  };
}
