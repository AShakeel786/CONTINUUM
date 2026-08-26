/**
 * Non-secret endpoint parameter resolution for OpenAI-compatible base URLs.
 *
 * A provider profile may declare `endpointParams: { paramName: envVarName }`
 * and reference `{paramName}` placeholders inside `baseUrl` (for example a
 * Cloudflare account id). Params are resolved from the environment at request
 * time — they are deliberately NOT stored secrets, so they never go through
 * CredentialManager. A missing required param makes the provider unusable;
 * callers surface it as an explicit config error rather than guessing.
 */

import type { ProviderProfile } from "./types.js";

/** The `endpointParams` map of a profile (paramName → envVarName). */
export function endpointParamMap(profile: Pick<ProviderProfile, "endpointParams">): ReadonlyMap<string, string> {
  return new Map(Object.entries(profile.endpointParams ?? {}));
}

/** Whether the profile declares any endpoint path parameters. */
export function hasEndpointParams(profile: Pick<ProviderProfile, "endpointParams">): boolean {
  return !!profile.endpointParams && Object.keys(profile.endpointParams).length > 0;
}

/**
 * Env var names for the profile's required endpoint params that are missing
 * from `env`. Empty when every declared param resolves.
 */
export function missingEndpointParams(profile: Pick<ProviderProfile, "endpointParams">, env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const missing: string[] = [];
  for (const envVar of endpointParamMap(profile).values()) {
    const value = env[envVar];
    if (!value || value.trim().length === 0) missing.push(envVar);
  }
  return missing;
}

/** Human-friendly summary of required-but-missing params (env var names). */
export function formatMissingEndpointParams(missing: readonly string[]): string {
  return missing.map((v) => v).join(", ");
}

/** Thrown when a baseUrl template references an unresolvable endpoint param. */
export class EndpointParamError extends Error {
  readonly paramNames: readonly string[];
  readonly envVars: readonly string[];

  constructor(providerId: string, paramNames: readonly string[], envVars: readonly string[]) {
    super(`provider "${providerId}" requires non-secret endpoint params (${paramNames.join(", ")}); set ${envVars.join(", ")}`);
    this.name = "EndpointParamError";
    this.paramNames = paramNames;
    this.envVars = envVars;
  }
}

/**
 * Substitute `{paramName}` placeholders in `baseUrl` from `env`. Throws
 * `EndpointParamError` when a declared placeholder is missing/unset or the URL
 * references an undeclared param. Unknown placeholders are treated as a
 * manifest/config error rather than silently left as literal braces.
 */
export function resolveEndpointUrl(
  baseUrl: string,
  profile: Pick<ProviderProfile, "id" | "endpointParams">,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const params = endpointParamMap(profile);
  let resolved = baseUrl;
  const missingNames: string[] = [];
  const missingVars: string[] = [];
  for (const [name, envVar] of params) {
    const token = `{${name}}`;
    if (!baseUrl.includes(token)) continue;
    const value = env[envVar];
    if (!value || value.trim().length === 0) {
      missingNames.push(name);
      missingVars.push(envVar);
      continue;
    }
    resolved = resolved.split(token).join(value.trim());
  }
  // A placeholder that names a param with no declared value is a hard config
  // error; a brace that names nothing in the manifest is a malformed baseUrl.
  const leftover = resolved.match(/\{[a-zA-Z0-9_-]+\}/g);
  if (leftover) {
    for (const token of leftover) {
      const name = token.slice(1, -1);
      if (!missingNames.includes(name)) {
        missingNames.push(name);
        missingVars.push(name);
      }
    }
  }
  if (missingNames.length > 0) throw new EndpointParamError(profile.id, missingNames, missingVars);
  return resolved;
}
