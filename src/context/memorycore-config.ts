/**
 * Single source of truth for resolving the MemoryCore gateway configuration
 * used by the launcher, the MCP server, and `doctor`.
 *
 * The audit (docs/DOGFOOD_PRODUCT_AUDIT.md P0-1) found a split brain:
 * `doctor` defaulted the endpoint to http://127.0.0.1:8420 while the launcher
 * and MCP required BOTH `CONTINUUM_MEMORY_CORE_URL` and
 * `CONTINUUM_MEMORY_CORE_TOKEN` to be set — so a healthy local MemoryCore
 * reported "not configured" at launch. This module unifies both halves:
 *
 *   - endpoint:  `CONTINUUM_MEMORY_CORE_URL`, defaulting to the local gateway
 *     (http://127.0.0.1:8420) — the same default `doctor` already uses.
 *   - token:     `CONTINUUM_MEMORY_CORE_TOKEN` if set (explicit override),
 *     otherwise the OS credential store under
 *     `credential://memorycore/service-token`. Never hardcoded; a missing
 *     token degrades to an actionable `reason` instead of silently mis-binding.
 *
 * Identity (service/team/user/agent) stays env-configurable with the
 * gateway's `"default"` bucket as the fallback — it is *not* a secret and is
 * deliberately kept out of the credential store.
 */

import { nativeBackendForPlatform } from "../auth/backends/detect.js";
import { CredentialManager, parseCredentialUri } from "../auth/credential-manager.js";
import { MissingSecretError } from "../providers/errors.js";
import { resolveSecret, type SecretRef } from "../providers/secrets.js";
import type { MemoryCoreGatewayConfig } from "./memorycore-client.js";

export const MEMORY_CORE_DEFAULT_URL = "http://127.0.0.1:8420";
export const MEMORY_CORE_URL_ENV = "CONTINUUM_MEMORY_CORE_URL";
export const MEMORY_CORE_SERVICE_TOKEN_ENV = "CONTINUUM_MEMORY_CORE_TOKEN";
/** Set to "1" to resolve the service token from env only (never the OS credential store). */
export const MEMORY_CORE_ENV_ONLY_ENV = "CONTINUUM_MEMORY_CORE_ENV_ONLY";
export const MEMORY_CORE_SERVICE_TOKEN_PROVIDER = "memorycore";
export const MEMORY_CORE_SERVICE_TOKEN_NAME = "service-token";

/** Endpoint discovery: env override, else the local gateway default. */
export function memoryCoreBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[MEMORY_CORE_URL_ENV]?.trim() || MEMORY_CORE_DEFAULT_URL;
}

export interface MemoryCoreResolution {
  /** Present when the gateway is fully configured (endpoint + token). */
  readonly config?: MemoryCoreGatewayConfig;
  /** Actionable, human-safe reason when the gateway is not configured. */
  readonly reason?: string;
}

export interface ResolveMemoryCoreOptions {
  readonly credentialManager?: CredentialManager;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/** Resolve the service-token reference: explicit env first, then the credential store. */
async function resolveServiceTokenRef(opts: ResolveMemoryCoreOptions): Promise<SecretRef | undefined> {
  const env = opts.env ?? process.env;
  const envToken = env[MEMORY_CORE_SERVICE_TOKEN_ENV]?.trim();
  if (envToken) return { envVar: MEMORY_CORE_SERVICE_TOKEN_ENV };
  if (
    opts.credentialManager &&
    (await opts.credentialManager.hasCredential(MEMORY_CORE_SERVICE_TOKEN_PROVIDER, MEMORY_CORE_SERVICE_TOKEN_NAME))
  ) {
    return {
      credentialUri: `credential://${MEMORY_CORE_SERVICE_TOKEN_PROVIDER}/${MEMORY_CORE_SERVICE_TOKEN_NAME}`,
    };
  }
  return undefined;
}

/**
 * The one resolution path. Returns a fully-resolved gateway config, or an
 * actionable reason explaining exactly how to configure the missing token.
 */
export async function resolveMemoryCoreConfig(opts: ResolveMemoryCoreOptions = {}): Promise<MemoryCoreResolution> {
  const env = opts.env ?? process.env;
  const baseUrl = memoryCoreBaseUrl(env);
  const serviceToken = await resolveServiceTokenRef(opts);

  if (!serviceToken) {
    return {
      reason:
        `MemoryCore token not configured — run \`continuum setup --memory\` ` +
        `to store the gateway service token in your secure credential store ` +
        `(or set ${MEMORY_CORE_SERVICE_TOKEN_ENV}).`,
    };
  }

  const config: MemoryCoreGatewayConfig = {
    baseUrl,
    serviceToken,
    serviceId: env.CONTINUUM_MEMORY_CORE_SERVICE_ID?.trim() || "default",
    teamId: env.CONTINUUM_MEMORY_CORE_TEAM_ID?.trim() || "default",
    userId: env.CONTINUUM_MEMORY_CORE_USER_ID?.trim() || "default",
    agentId: env.CONTINUUM_MEMORY_CORE_AGENT_ID?.trim() || "default",
    timeoutMs: opts.timeoutMs ?? 3000,
    // Async token resolution: env-var shape reads env; credential shape reads
    // the OS credential store. Resolved only at call time so the value never
    // sits in a config object or leaks into a spawned provider CLI's env.
    resolveToken: async (ref) => {
      if (ref.envVar !== undefined) return resolveSecret("memorycore-gateway", ref, env);
      if (ref.credentialUri) {
        const parsed = parseCredentialUri(ref.credentialUri);
        if (!parsed) throw new MissingSecretError("memorycore-gateway", ref.credentialUri);
        if (!opts.credentialManager) throw new MissingSecretError("memorycore-gateway", ref.credentialUri);
        return opts.credentialManager.getCredential(parsed.providerId, parsed.name);
      }
      throw new MissingSecretError("memorycore-gateway", "<unresolvable>");
    },
  };

  return { config };
}

/** Store the gateway service token in the secure credential backend. Returns the reference. */
export async function storeMemoryCoreServiceToken(credentialManager: CredentialManager, value: string): Promise<string> {
  return credentialManager.setCredential(MEMORY_CORE_SERVICE_TOKEN_PROVIDER, MEMORY_CORE_SERVICE_TOKEN_NAME, value);
}

/**
 * Build a credential manager from the platform-native backend when available
 * (no interactive prompt needed for the OS keychain). Returns undefined when
 * no native backend is usable — callers then degrade to env-only memory config.
 * The encrypted-file fallback is intentionally not used here: it requires an
 * interactive passphrase, which a non-interactive MCP subprocess cannot supply.
 */
export async function buildDefaultCredentialManager(dataDir?: string): Promise<CredentialManager | undefined> {
  // The OS credential store is global (not scoped by CONTINUUM_HOME). Expose an
  // explicit opt-out so isolated runs (tests, env-only deployments) never touch
  // it — the token then degrades to the env var only.
  if (process.env[MEMORY_CORE_ENV_ONLY_ENV] === "1") return undefined;
  const native = nativeBackendForPlatform(dataDir);
  if (native && (await native.isAvailable())) return new CredentialManager(native);
  return undefined;
}
