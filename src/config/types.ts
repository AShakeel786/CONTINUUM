export const CONFIG_SCHEMA_VERSION = 1;

export type ProviderAuthMethod = "api" | "cli";

/**
 * Non-secret record of how a provider was configured. `credentialKey`
 * (present only for `method: "api"`) is the CredentialBackend lookup key —
 * a reference, never a value. This is the concrete embodiment of "CONTINUUM
 * config should store references such as `credential://deepseek/api-key`
 * not secret values."
 */
export interface ProviderAuthConfigEntry {
  readonly providerId: string;
  readonly method: ProviderAuthMethod;
  readonly credentialKey?: string;
  readonly configuredAt: string;
}

export interface ContinuumConfig {
  readonly schemaVersion: number;
  readonly credentialBackendId?: string;
  readonly providers: readonly ProviderAuthConfigEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function emptyConfig(now: string): ContinuumConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, providers: [], createdAt: now, updatedAt: now };
}
