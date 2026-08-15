/**
 * Typed provider errors. Every error here carries structured fields (never
 * a raw secret value) so callers can branch on failure kind instead of
 * string-matching messages.
 */

export class UnknownProviderError extends Error {
  readonly providerId: string;
  constructor(providerId: string, knownIds: readonly string[]) {
    super(
      `Unknown provider "${providerId}". Registered providers: ${knownIds.length ? knownIds.join(", ") : "(none)"}.`,
    );
    this.name = "UnknownProviderError";
    this.providerId = providerId;
  }
}

export class DuplicateProviderError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`Provider "${providerId}" is already registered.`);
    this.name = "DuplicateProviderError";
    this.providerId = providerId;
  }
}

/**
 * A secret env var was required but missing/empty. Never includes the
 * resolved value (there isn't one to include) — only the var name and
 * which provider needed it, safe to log.
 */
export class MissingSecretError extends Error {
  readonly providerId: string;
  readonly envVar: string;
  constructor(providerId: string, envVar: string) {
    super(`Provider "${providerId}" requires env var "${envVar}" to be set, but it is missing or empty.`);
    this.name = "MissingSecretError";
    this.providerId = providerId;
    this.envVar = envVar;
  }
}

export class ProviderConfigError extends Error {
  readonly providerId: string;
  constructor(providerId: string, reason: string) {
    super(`Provider "${providerId}" config error: ${reason}`);
    this.name = "ProviderConfigError";
    this.providerId = providerId;
  }
}

/**
 * Auth/connectivity failure surfaced by a specific provider adapter (e.g.
 * DeepSeek-via-Tencent-proxy rejecting a user key, or a native-Claude CLI
 * session with no active login). Distinct from MissingSecretError: this is
 * "the secret resolved but the provider rejected it," not "no secret found."
 */
export class ProviderAuthError extends Error {
  readonly providerId: string;
  constructor(providerId: string, reason: string) {
    super(`Provider "${providerId}" auth failed: ${reason}`);
    this.name = "ProviderAuthError";
    this.providerId = providerId;
  }
}

export class UnknownModelAliasError extends Error {
  readonly providerId: string;
  readonly alias: string;
  constructor(providerId: string, alias: string, knownAliases: readonly string[]) {
    super(
      `Provider "${providerId}" has no model mapping for alias "${alias}". ` +
      `Known aliases: default, ${knownAliases.join(", ") || "(none)"}.`,
    );
    this.name = "UnknownModelAliasError";
    this.providerId = providerId;
    this.alias = alias;
  }
}
