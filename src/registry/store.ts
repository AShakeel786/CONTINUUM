/**
 * Durable project-registry store. Reuses the same atomic-write primitive as
 * config and sessions, so a partial write can never corrupt the registry.
 * Lives under `~/.continuum/projects.json` (or `$CONTINUUM_HOME`), resolved
 * through the same `resolveDataDir` the config and credential systems use —
 * one data dir for all CONTINUUM local state.
 */

import { atomicWriteJson, fileExists, readJsonWithRecovery } from "../session/atomic-file.js";
import { resolveDataDir } from "../config/paths.js";
import { PROJECT_SCHEMA_VERSION, type ProjectRecord, type ProjectRegistryFile } from "./types.js";

function resolveRegistryPath(dataDir: string): string {
  return `${dataDir}/projects.json`;
}

const EMPTY: ProjectRegistryFile = { schemaVersion: PROJECT_SCHEMA_VERSION, projects: [] };

export class ProjectRegistryStore {
  private readonly filePath: string;

  constructor(dataDir: string = resolveDataDir()) {
    this.filePath = resolveRegistryPath(dataDir);
  }

  async load(): Promise<ProjectRegistryFile> {
    if (!(await fileExists(this.filePath))) return EMPTY;
    const { data } = await readJsonWithRecovery<ProjectRegistryFile>(this.filePath);
    return data;
  }

  async save(reg: ProjectRegistryFile): Promise<void> {
    await atomicWriteJson(this.filePath, reg);
  }

  async list(): Promise<readonly ProjectRecord[]> {
    return (await this.load()).projects;
  }
}
