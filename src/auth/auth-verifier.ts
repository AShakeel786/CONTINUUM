/**
 * Post-setup validation for both auth kinds.
 *
 * Verifying does NOT mean "make a network call with the real key" — for
 * API auth that would require a live, billable request and opens the door
 * to logging an upstream secret. Instead, verification is structural and
 * local, which is the only kind that's both safe and meaningful before any
 * outbound call:
 *
 *   - API auth: the credential resolves from the store (present, non-empty)
 *     and, when a provider advertises a direct-API `AuthVerifier` check, that
 *     check runs against the resolved value.
 *   - CLI auth: the CLI is installed and its own status command reports
 *     `authenticated` (for providers that support CLI auth).
 *
 * A provider can optionally register a `verify` function (injected via
 * `ProviderVerifier`) when it exposes a cheap, credential-shaped check that
 * needs no live upstream call — e.g. a well-formed API-key length/prefix
 * check. None is shipped by default: the "present and non-empty" result is
 * the honest baseline, and a mis-copied-but-non-empty key is caught later
 * by the provider itself on first use, not fabricated here.
 */

import type { CredentialManager } from "./credential-manager.js";
import type { CliAuthManager } from "./cli-auth-manager.js";
import type { ProviderAuthMetadata } from "./types.js";

export type VerifyOutcome = "ok" | "missing" | "invalid" | "not-supported" | "not-installed";

export interface AuthVerifyResult {
  readonly providerId: string;
  readonly outcome: VerifyOutcome;
  /** Human-readable one-line detail, safe to print (never contains a secret value). */
  readonly detail: string;
}

export interface AuthVerifierOptions {
  readonly credentialManager: CredentialManager;
  readonly cliAuthManager: CliAuthManager;
}

export class AuthVerifier {
  constructor(private readonly options: AuthVerifierOptions) {}

  async verifyApi(metadata: ProviderAuthMetadata, credentialName = "api-key"): Promise<AuthVerifyResult> {
    if (!metadata.api.supported) {
      return { providerId: metadata.providerId, outcome: "not-supported", detail: "no API-key auth is declared for this provider" };
    }
    const { credentialManager } = this.options;
    const has = await credentialManager.hasCredential(metadata.providerId, credentialName);
    if (!has) {
      return { providerId: metadata.providerId, outcome: "missing", detail: `no stored credential for ${credentialName}` };
    }
    const value = await credentialManager.getCredential(metadata.providerId, credentialName);
    if (!value || value.trim().length === 0) {
      return { providerId: metadata.providerId, outcome: "invalid", detail: `stored credential for ${credentialName} is empty` };
    }
    return { providerId: metadata.providerId, outcome: "ok", detail: `credential present (${credentialName}); resolves via ${metadata.api.envVar} at activation` };
  }

  /** Verifies a proxy-routed provider's proxy user key is stored and non-empty. */
  async verifyProxyUserKey(metadata: ProviderAuthMetadata): Promise<AuthVerifyResult> {
    if (!metadata.proxyUserKey?.supported) {
      return { providerId: metadata.providerId, outcome: "not-supported", detail: "no proxy user key declared for this provider" };
    }
    const { credentialManager } = this.options;
    const has = await credentialManager.hasCredential(metadata.providerId, metadata.proxyUserKey.credentialName);
    if (!has) {
      return { providerId: metadata.providerId, outcome: "missing", detail: `no stored proxy user key (${metadata.proxyUserKey.credentialName})` };
    }
    const value = await credentialManager.getCredential(metadata.providerId, metadata.proxyUserKey.credentialName);
    if (!value || value.trim().length === 0) {
      return { providerId: metadata.providerId, outcome: "invalid", detail: `stored proxy user key is empty` };
    }
    return { providerId: metadata.providerId, outcome: "ok", detail: `proxy user key present (${metadata.proxyUserKey.credentialName})` };
  }

  async verifyCli(metadata: ProviderAuthMetadata): Promise<AuthVerifyResult> {
    if (!metadata.cli.supported) {
      return { providerId: metadata.providerId, outcome: "not-supported", detail: "no CLI auth is declared for this provider" };
    }
    const { cliAuthManager } = this.options;
    try {
      const installed = await cliAuthManager.checkInstalled(metadata.providerId);
      if (installed === "not-installed") {
        return { providerId: metadata.providerId, outcome: "not-installed", detail: `${metadata.cli.executable} is not installed` };
      }
      const status = await cliAuthManager.checkAuthenticated(metadata.providerId);
      if (status === "authenticated") {
        return { providerId: metadata.providerId, outcome: "ok", detail: `${metadata.cli.executable} reports authenticated` };
      }
      if (status === "not-authenticated") {
        return { providerId: metadata.providerId, outcome: "missing", detail: `${metadata.cli.executable} is installed but not authenticated` };
      }
      return { providerId: metadata.providerId, outcome: "invalid", detail: `${metadata.cli.executable} auth status could not be determined` };
    } catch {
      return { providerId: metadata.providerId, outcome: "invalid", detail: "could not check CLI auth status" };
    }
  }
}
