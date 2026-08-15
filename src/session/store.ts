/**
 * FileSessionStore — the durable local backend (brief: "Use a simple local
 * durable backend first unless there is a strong reason otherwise. Do not
 * over-engineer distributed state."). One JSON file per session, under
 * `<baseDir>/<sessionId>.json`, written via `atomic-file.ts`'s
 * write-temp+fsync+backup+rename primitive.
 */

import path from "node:path";
import { atomicWriteJson, fileExists, readJsonWithRecovery } from "./atomic-file.js";
import { SessionConflictError, SessionNotFoundError, UnsupportedSchemaVersionError } from "./errors.js";
import { SESSION_SCHEMA_VERSION, type TaskSession } from "./types.js";

export interface SaveOptions {
  /**
   * The revision the caller last read. If provided and the file on disk has
   * since moved to a different revision, the write is rejected with
   * `SessionConflictError` instead of silently overwriting newer work.
   * Omit only for the very first save of a brand-new session.
   */
  readonly expectedRevision?: number;
}

/** Identity migration for the only schema version that exists so far — the extension point future versions hook into. */
function migrate(session: TaskSession): TaskSession {
  if (session.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(session.schemaVersion, SESSION_SCHEMA_VERSION);
  }
  // session.schemaVersion === SESSION_SCHEMA_VERSION (1): no migration needed yet.
  return session;
}

export class FileSessionStore {
  constructor(private readonly baseDir: string) {}

  private filePath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.json`);
  }

  async exists(sessionId: string): Promise<boolean> {
    return fileExists(this.filePath(sessionId));
  }

  async load(sessionId: string): Promise<TaskSession> {
    const filePath = this.filePath(sessionId);
    if (!(await fileExists(filePath))) {
      throw new SessionNotFoundError(sessionId);
    }
    const { data } = await readJsonWithRecovery<TaskSession>(filePath);
    return migrate(data);
  }

  /**
   * Persists a session. When `opts.expectedRevision` is given, first checks
   * the file currently on disk (if any) still has that exact revision —
   * otherwise throws `SessionConflictError` rather than clobbering a write
   * that happened in between load and save.
   */
  async save(session: TaskSession, opts: SaveOptions = {}): Promise<void> {
    const filePath = this.filePath(session.sessionId);
    if (opts.expectedRevision !== undefined) {
      const exists = await fileExists(filePath);
      if (exists) {
        const { data: onDisk } = await readJsonWithRecovery<TaskSession>(filePath);
        if (onDisk.revision !== opts.expectedRevision) {
          throw new SessionConflictError(session.sessionId, opts.expectedRevision, onDisk.revision);
        }
      }
    }
    await atomicWriteJson(filePath, session);
  }

  async delete(sessionId: string): Promise<void> {
    const filePath = this.filePath(sessionId);
    const fsPromises = await import("node:fs/promises");
    await fsPromises.rm(filePath, { force: true });
    await fsPromises.rm(`${filePath}.bak`, { force: true });
  }

  async listSessionIds(): Promise<string[]> {
    const fsPromises = await import("node:fs/promises");
    try {
      const entries = await fsPromises.readdir(this.baseDir);
      return entries.filter((e) => e.endsWith(".json") && !e.startsWith(".")).map((e) => e.slice(0, -".json".length));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
