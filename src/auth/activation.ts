/**
 * Bridges Phase 6's credential store to Phase 3's existing, unmodified
 * env-var-based `SecretRef`/`resolveSecret` contract — deliberately, rather
 * than changing that contract. `ProviderProfile.auth.secret.envVar`
 * (Phase 3) already names exactly which env var a provider's direct-API
 * auth expects; this module's only job is populating that var's value from
 * the credential store, so a user configuring a provider through `auth`
 * never has to `export`/set it by hand.
 *
 * Deliberately narrow: returns a plain env-var object for the *caller* to
 * merge into a child process's `env` (e.g. `child_process.spawn(..., {env})`)
 * or a short-lived scope — this module never mutates the running process's
 * own `process.env` globally, which would leak the credential into every
 * unrelated code path for the rest of the process lifetime.
 */

import type { ProviderAdapter } from "../providers/types.js";
import { CredentialManager } from "./credential-manager.js";
import { InvalidCredentialError } from "./errors.js";
import type { ApiCredentialReference } from "./types.js";

/**
 * Resolves the env var CONTINUUM's stored credential should populate for a
 * given provider's direct-API auth, or `undefined` if that provider's auth
 * strategy isn't credential-backed (`cli-session`, or no auth declared).
 */
export function envVarForProviderAuth(adapter: ProviderAdapter): string | undefined {
  const auth = adapter.profile.auth;
  return auth.kind === "api-key" || auth.kind === "bearer-token" ? auth.secret.envVar : undefined;
}

/**
 * Builds `{ [envVar]: value }` for a provider whose API credential is
 * stored under `credentialName` (default `"api-key"`). Throws
 * `InvalidCredentialError` (not the raw `CredentialNotFoundError`) when the
 * provider's auth strategy isn't credential-backed at all — a config/logic
 * error, distinct from "the credential just hasn't been set up yet".
 */
export async function resolveProviderAuthEnv(
  adapter: ProviderAdapter,
  credentialManager: CredentialManager,
  credential: ApiCredentialReference | string = { providerId: adapter.profile.id, name: "api-key" },
): Promise<Readonly<Record<string, string>>> {
  const envVar = envVarForProviderAuth(adapter);
  if (!envVar) {
    throw new InvalidCredentialError(adapter.profile.id, "this provider's auth strategy is not credential-store-backed (cli-session or unsupported)");
  }
  // Preserve the original public third-argument form (`credentialName`) while
  // allowing trusted metadata to point at a shared provider/name pair.
  const credentialRef = typeof credential === "string"
    ? { providerId: adapter.profile.id, name: credential }
    : credential;
  const value = await credentialManager.getCredential(credentialRef.providerId, credentialRef.name);
  return { [envVar]: value };
}
