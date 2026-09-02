/**
 * Project registry — CRUD + alias/CWD resolution over the durable store.
 * Pure data operations; no launch logic, no provider knowledge beyond a
 * default-provider *id* stored as config.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ProjectAlreadyExistsError, ProjectConflictError, ProjectNotFoundError } from "./errors.js";
import { ProjectRegistryStore } from "./store.js";
import { PROJECT_SCHEMA_VERSION, type ProjectRecord, type ProjectRegistryFile } from "./types.js";

export interface AddProjectInput {
  readonly name: string;
  readonly path: string;
  readonly aliases?: readonly string[];
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly path?: string;
  readonly aliases?: readonly string[];
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
}

function now(): string {
  return new Date().toISOString();
}

/** Normalizes a project path to an absolute path, resolving `~`. Never touches the filesystem. */
export function normalizeProjectPath(p: string): string {
  const expanded = p.startsWith("~") ? path.join(process.env.HOME ?? "", p.slice(1)) : p;
  return path.resolve(expanded);
}

export class ProjectRegistry {
  private readonly pathById = new Map<string, string>();

  constructor(private readonly store: ProjectRegistryStore) {}

  /** Re-indexes name/alias/id → record id. Called at construction and after every mutation. */
  private async rebuildIndex(): Promise<void> {
    const reg = await this.store.load();
    this.pathById.clear();
    for (const p of reg.projects) {
      this.pathById.set(p.id, p.id);
      this.pathById.set(p.name.toLowerCase(), p.id);
      for (const a of p.aliases) this.pathById.set(a.toLowerCase(), p.id);
    }
  }

  /** Resolve a name/alias/id to a project record, throwing `ProjectNotFoundError` otherwise. */
  async resolve(key: string): Promise<ProjectRecord> {
    await this.rebuildIndex();
    const reg = await this.store.load();
    const id = this.pathById.get(key) ?? this.pathById.get(key.toLowerCase());
    if (!id) throw new ProjectNotFoundError(key);
    const record = reg.projects.find((p) => p.id === id);
    if (!record) throw new ProjectNotFoundError(key);
    return record;
  }

  /**
   * Detect the project for a working directory: exact path match first, then
   * the deepest ancestor that is a registered project path. Returns undefined
   * when no project contains this CWD.
   *
   * A project registered at the user's home directory (or the filesystem
   * root) is only ever an EXACT match — it is never used as an ancestor.
   * Such a "project" is a catch-all that contains virtually every path, so
   * ancestor-matching it silently swaps the directory the user is actually
   * working in for `$HOME` (observed: an API-agent session whose coding
   * tools then rooted at `/Users/<me>` instead of the real repo). An
   * unmatched CWD must surface as "no project" so the caller can prompt,
   * not resolve to the home catch-all.
   */
  async detect(cwd: string): Promise<ProjectRecord | undefined> {
    const reg = await this.store.load();
    const abs = normalizeProjectPath(cwd);
    // Exact match wins — including an exact match on the home dir itself.
    const exact = reg.projects.find((p) => normalizeProjectPath(p.path) === abs);
    if (exact) return exact;
    const home = normalizeProjectPath(os.homedir());
    const fsRoot = path.parse(abs).root;
    // Deepest ancestor: longest matching path prefix on a segment boundary,
    // excluding the home dir / filesystem root as ancestors.
    let best: ProjectRecord | undefined;
    let bestLen = -1;
    for (const p of reg.projects) {
      const base = normalizeProjectPath(p.path);
      if (base === home || base === fsRoot) continue;
      if (abs === base || abs.startsWith(base + path.sep)) {
        if (base.length > bestLen) {
          best = p;
          bestLen = base.length;
        }
      }
    }
    return best;
  }

  async add(input: AddProjectInput): Promise<ProjectRecord> {
    const reg = await this.store.load();
    const normalizedPath = normalizeProjectPath(input.path);

    // Uniqueness: no two projects may share a name, alias, or path.
    const nameClash = reg.projects.find((p) => p.name.toLowerCase() === input.name.toLowerCase());
    if (nameClash) throw new ProjectAlreadyExistsError(input.name, `name "${input.name}" is already used by a project`);
    const pathClash = reg.projects.find((p) => normalizeProjectPath(p.path) === normalizedPath);
    if (pathClash) throw new ProjectAlreadyExistsError(input.name, `path "${normalizedPath}" is already registered`);
    for (const alias of input.aliases ?? []) {
      const aliasClash = reg.projects.find(
        (p) =>
          p.name.toLowerCase() === alias.toLowerCase() ||
          p.aliases.some((a) => a.toLowerCase() === alias.toLowerCase()),
      );
      if (aliasClash) throw new ProjectAlreadyExistsError(input.name, `alias "${alias}" is already used`);
    }

    const record: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      path: normalizedPath,
      aliases: [...(input.aliases ?? [])],
      ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
      ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
      createdAt: now(),
      updatedAt: now(),
    };

    await this.store.save({ schemaVersion: PROJECT_SCHEMA_VERSION, projects: [...reg.projects, record] });
    await this.rebuildIndex();
    return record;
  }

  async update(idOrKey: string, input: UpdateProjectInput): Promise<ProjectRecord> {
    const existing = await this.resolve(idOrKey);
    const reg = await this.store.load();

    const normalizedPath = input.path ? normalizeProjectPath(input.path) : existing.path;
    const newName = input.name ?? existing.name;

    // Conflict checks against *other* projects.
    const others = reg.projects.filter((p) => p.id !== existing.id);
    if (input.name && others.some((p) => p.name.toLowerCase() === input.name!.toLowerCase())) {
      throw new ProjectAlreadyExistsError(input.name, `name "${input.name}" is already used`);
    }
    if (input.path && others.some((p) => normalizeProjectPath(p.path) === normalizedPath)) {
      throw new ProjectAlreadyExistsError(input.name ?? existing.name, `path "${normalizedPath}" is already registered`);
    }
    for (const alias of input.aliases ?? []) {
      if (others.some((p) => p.name.toLowerCase() === alias.toLowerCase() || p.aliases.some((a) => a.toLowerCase() === alias.toLowerCase()))) {
        throw new ProjectAlreadyExistsError(input.name ?? existing.name, `alias "${alias}" is already used`);
      }
    }

    const updated: ProjectRecord = {
      ...existing,
      name: newName,
      path: normalizedPath,
      aliases: input.aliases !== undefined ? [...input.aliases] : existing.aliases,
      defaultProvider: input.defaultProvider !== undefined ? input.defaultProvider : existing.defaultProvider,
      defaultModel: input.defaultModel !== undefined ? input.defaultModel : existing.defaultModel,
      updatedAt: now(),
    };

    await this.store.save({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projects: reg.projects.map((p) => (p.id === existing.id ? updated : p)),
    });
    await this.rebuildIndex();
    return updated;
  }

  /**
   * Lazy one-time migration: rewrite any persisted `defaultProvider` that is a
   * retired provider id to its current canonical id (e.g. `local-qwen38` →
   * `local-ornith15`). Uses the same atomic checksummed `save()` path as every
   * other mutation — never a manual file edit. Returns the project ids changed
   * (empty = nothing to migrate; no write performed).
   */
  async migrateProviderIds(canonicalize: (providerId: string) => string): Promise<readonly string[]> {
    const reg = await this.store.load();
    const changed: string[] = [];
    const projects = reg.projects.map((p) => {
      if (!p.defaultProvider) return p;
      const canon = canonicalize(p.defaultProvider);
      if (canon === p.defaultProvider) return p;
      changed.push(p.id);
      return { ...p, defaultProvider: canon, updatedAt: now() };
    });
    if (changed.length > 0) {
      await this.store.save({ schemaVersion: PROJECT_SCHEMA_VERSION, projects });
      await this.rebuildIndex();
    }
    return changed;
  }

  async remove(idOrKey: string): Promise<void> {
    const existing = await this.resolve(idOrKey);
    const reg = await this.store.load();
    await this.store.save({ schemaVersion: PROJECT_SCHEMA_VERSION, projects: reg.projects.filter((p) => p.id !== existing.id) });
    await this.rebuildIndex();
  }

  async list(): Promise<readonly ProjectRecord[]> {
    return this.store.list();
  }

  /** True if any registered project path contains the given cwd. */
  async hasProjectForCwd(cwd: string): Promise<boolean> {
    return (await this.detect(cwd)) !== undefined;
  }

  /** Validates a default-provider id against a set of known provider ids; throws on unknown. */
  validateProvider(providerId: string | undefined, knownProviders: ReadonlySet<string>): void {
    if (providerId && !knownProviders.has(providerId)) {
      throw new ProjectConflictError(`unknown default provider "${providerId}" (known: ${[...knownProviders].join(", ")})`);
    }
  }
}
