/**
 * CONTINUUM project registry — the cross-platform replacement for the old
 * Windows `windows/tencent-project-registry.json` + `Add-TencentProject.ps1`.
 *
 * A project is a named working directory (optionally aliased), with an
 * optional default provider + model used when a launch doesn't specify one.
 * No secrets live here — a "default provider" is a provider id (a key into
 * the auth/credential system, which owns the actual secret), never a
 * credential value. This registry is pure data + CRUD; launch orchestration
 * lives in `src/launcher/`.
 */

export const PROJECT_SCHEMA_VERSION = 1;

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  /** CWD-based detection key — the absolute path this project lives in. */
  readonly path: string;
  /** Alternate names resolve to the same project (e.g. "cars" for a long name). */
  readonly aliases: readonly string[];
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectRegistryFile {
  readonly schemaVersion: number;
  readonly projects: readonly ProjectRecord[];
}
