/**
 * Per-provider "let's get you authenticated" flow. Switches on the *shape*
 * of a provider's auth metadata (`api.supported` / `cli.supported`
 * discriminants) — never on provider identity — exactly like the rest of
 * the codebase (data describes the shape, one generic flow interprets it).
 *
 *   - API-key auth: prompt (masked) for the key, store it in the selected
 *     `CredentialBackend` via `CredentialManager`, and record a
 *     `credential://<provider>/api-key` reference in the config.
 *   - CLI auth: run the provider's official interactive login (inheriting
 *     stdio so the real OAuth/browser flow runs unchanged), then record
 *     `method: "cli"` in the config without ever seeing a token.
 *
 * Both paths also support replace (re-run the same flow) and remove
 * (delete the stored credential + drop the config entry), which the `auth`
 * command surfaces.
 */

import type { CredentialManager } from "./credential-manager.js";
import type { CliAuthManager } from "./cli-auth-manager.js";
import type { ContinuumConfig } from "../config/types.js";
import type { Prompt } from "./prompt.js";
import type { ProviderAuthMetadata } from "./types.js";
import type { ProviderAuthConfigEntry, ProviderAuthMethod } from "../config/types.js";

export type SetupAction = "setup" | "replace" | "remove";

export interface SetupChoice {
  /** Which auth method the flow settled on (for API+CLI providers the wizard may have asked). */
  readonly method: ProviderAuthMethod;
}

export interface ProviderSetupDeps {
  readonly credentialManager: CredentialManager;
  readonly cliAuthManager: CliAuthManager;
  readonly prompt: Prompt;
}

export interface ProviderSetupResult {
  readonly providerId: string;
  readonly method: ProviderAuthMethod;
  /** The stored credential reference (only for `method: "api"`); `cli` returns undefined. */
  readonly credentialUri?: string;
}

const API_KEY_CREDENTIAL_NAME = "api-key";

export class ProviderSetup {
  constructor(private readonly deps: ProviderSetupDeps) {}

  /**
   * Runs the full setup flow for one provider. If the provider supports both
   * API and CLI auth, `preferredMethod` disambiguates; otherwise it uses the
   * only supported method.
   */
  async setup(metadata: ProviderAuthMetadata, preferredMethod?: ProviderAuthMethod): Promise<ProviderSetupResult> {
    const method = this.chooseMethod(metadata, preferredMethod);
    if (method === "api") return this.setupApi(metadata);
    return this.setupCli(metadata);
  }

  /** Store an API key (masked prompt) and return its reference. */
  async setupApi(metadata: ProviderAuthMetadata): Promise<ProviderSetupResult> {
    if (!metadata.api.supported) {
      throw new Error(`provider "${metadata.providerId}" does not support API-key auth`);
    }
    const { credentialManager, prompt } = this.deps;
    const label = `API key for ${metadata.providerId} (env var ${metadata.api.envVar})`;
    const value = await prompt.askSecret(label);
    const trimmed = value.trim();
    if (!trimmed) return { providerId: metadata.providerId, method: "api", credentialUri: undefined };
    const uri = await credentialManager.setCredential(metadata.providerId, API_KEY_CREDENTIAL_NAME, trimmed);
    return { providerId: metadata.providerId, method: "api", credentialUri: uri };
  }

  /** Run the provider's official interactive CLI login. */
  async setupCli(metadata: ProviderAuthMetadata): Promise<ProviderSetupResult> {
    if (!metadata.cli.supported) {
      throw new Error(`provider "${metadata.providerId}" does not support CLI auth`);
    }
    const { cliAuthManager } = this.deps;
    const result = await cliAuthManager.login(metadata.providerId);
    if (!result.completed) {
      throw new Error(`CLI login for "${metadata.providerId}" did not complete (exit ${result.exitCode})`);
    }
    return { providerId: metadata.providerId, method: "cli" };
  }

  /**
   * Remove a provider's stored credential (API) and/or nothing for CLI
   * (CLI logout is surfaced separately via the adapter, not here — removing
   * the config entry is the durable "forget" for CLI auth).
   */
  async remove(metadata: ProviderAuthMetadata): Promise<void> {
    if (metadata.api.supported) {
      await this.deps.credentialManager.deleteCredential(metadata.providerId, API_KEY_CREDENTIAL_NAME);
    }
  }

  /** Insert/replace the config entry for a provider, keyed by id. */
  applyConfigEntry(config: ContinuumConfig, providerId: string, method: ProviderAuthMethod, credentialUri?: string): ContinuumConfig {
    const entry: ProviderAuthConfigEntry = {
      providerId,
      method,
      ...(method === "api" ? { credentialKey: credentialUri } : {}),
      configuredAt: new Date().toISOString(),
    };
    const providers = config.providers.filter((p) => p.providerId !== providerId);
    return { ...config, providers: [...providers, entry], updatedAt: new Date().toISOString() };
  }

  /** Drop the config entry for a provider (used by remove). */
  removeConfigEntry(config: ContinuumConfig, providerId: string): ContinuumConfig {
    return { ...config, providers: config.providers.filter((p) => p.providerId !== providerId), updatedAt: new Date().toISOString() };
  }

  private chooseMethod(metadata: ProviderAuthMetadata, preferred?: ProviderAuthMethod): ProviderAuthMethod {
    const api = metadata.api.supported;
    const cli = metadata.cli.supported;
    if (api && cli) return preferred ?? "cli";
    if (api) return "api";
    if (cli) return "cli";
    throw new Error(`provider "${metadata.providerId}" declares no supported auth method`);
  }
}
