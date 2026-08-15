/**
 * Secret handling for provider profiles.
 *
 * A provider profile must never hold a literal credential — only a
 * `SecretRef` naming the environment variable that holds it. Resolution
 * happens at call time, reads from an injectable env map (defaults to
 * `process.env`), and is the only place a real value briefly exists in
 * memory. Nothing in this module logs, prints, or returns a value alongside
 * its own name in a way that would land in a serialized profile.
 */

import { MissingSecretError } from "./errors.js";

/** A reference to a secret's location, never the secret itself. */
export interface SecretRef {
  readonly envVar: string;
}

export function secretRef(envVar: string): SecretRef {
  return { envVar };
}

/**
 * Resolve a SecretRef to its value. Throws MissingSecretError (safe to log —
 * carries only the var name) if unset or empty. `env` defaults to
 * `process.env` but accepts an injected map so tests can verify resolution
 * and isolation without touching the real process environment.
 */
export function resolveSecret(
  providerId: string,
  ref: SecretRef,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env[ref.envVar];
  if (!value || !value.trim()) {
    throw new MissingSecretError(providerId, ref.envVar);
  }
  return value;
}

/**
 * True if the secret is currently resolvable, without throwing or
 * returning the value — for capability/health-style checks that shouldn't
 * ever hold the resolved value longer than necessary.
 */
export function isSecretResolvable(
  ref: SecretRef,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env[ref.envVar];
  return !!value && value.trim().length > 0;
}
