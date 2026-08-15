export class CredentialBackendUnavailableError extends Error {
  readonly backendId: string;
  constructor(backendId: string, reason: string) {
    super(`Credential backend "${backendId}" is unavailable: ${reason}`);
    this.name = "CredentialBackendUnavailableError";
    this.backendId = backendId;
  }
}

export class CredentialNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`No credential found for "${key}".`);
    this.name = "CredentialNotFoundError";
    this.key = key;
  }
}

export class NoCredentialBackendAvailableError extends Error {
  constructor(attempted: readonly string[]) {
    super(
      `No credential backend is available on this machine (tried: ${attempted.join(", ")}). ` +
      `Install a supported native backend, or accept the encrypted-file fallback when prompted.`,
    );
    this.name = "NoCredentialBackendAvailableError";
  }
}

export class InvalidCredentialError extends Error {
  readonly providerId: string;
  constructor(providerId: string, reason: string) {
    super(`Credential for "${providerId}" failed validation: ${reason}`);
    this.name = "InvalidCredentialError";
    this.providerId = providerId;
  }
}
