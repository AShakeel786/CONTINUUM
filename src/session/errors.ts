export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session "${sessionId}" does not exist.`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

export class SessionCorruptionError extends Error {
  readonly filePath: string;
  constructor(filePath: string, detail: string) {
    super(`Session file "${filePath}" is corrupted and unrecoverable (${detail}).`);
    this.name = "SessionCorruptionError";
    this.filePath = filePath;
  }
}

/**
 * Optimistic-concurrency violation: a write was attempted against a stale
 * in-memory copy of the session (its `revision` no longer matches what's on
 * disk) — someone else's newer write would otherwise be silently
 * overwritten. Matches the brief's "do not overwrite newer work."
 */
export class SessionConflictError extends Error {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(sessionId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Session "${sessionId}" was modified concurrently (expected revision ${expectedRevision}, found ${actualRevision}). Reload before retrying.`,
    );
    this.name = "SessionConflictError";
    this.sessionId = sessionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class UnsupportedSchemaVersionError extends Error {
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number) {
    super(`Session schema version ${found} is newer than this build supports (${supported}). Refusing to guess at a downgrade.`);
    this.name = "UnsupportedSchemaVersionError";
    this.found = found;
    this.supported = supported;
  }
}
