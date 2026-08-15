/**
 * Non-secret CONTINUUM config (which credential backend is active, which
 * providers are configured and how — references only, never values).
 *
 * Reuses `session/atomic-file.ts`'s write-temp+fsync+backup+rename +
 * checksum-verified-corruption-recovery primitive directly rather than
 * duplicating it — it's already generic (nothing session-specific in its
 * mechanics) and already tested. The one adaptation: `readJsonWithRecovery`
 * throws `SessionCorruptionError` by name (a Phase 5 leftover, not touched
 * here to avoid any risk to Phase 5's existing tests) — this module catches
 * it and re-throws its own `ConfigCorruptionError` so callers never see a
 * "Session" name for a config-file problem.
 */

import { atomicWriteJson, fileExists, readJsonWithRecovery } from "../session/atomic-file.js";
import { resolveConfigFilePath, resolveDataDir } from "./paths.js";
import { CONFIG_SCHEMA_VERSION, emptyConfig, type ContinuumConfig } from "./types.js";
import { ConfigCorruptionError } from "./errors.js";

export class ConfigStore {
  private readonly filePath: string;

  constructor(dataDir: string = resolveDataDir()) {
    this.filePath = resolveConfigFilePath(dataDir);
  }

  async exists(): Promise<boolean> {
    return fileExists(this.filePath);
  }

  /** Loads the config, or returns a fresh empty one if none exists yet — first-run is not an error. */
  async load(): Promise<ContinuumConfig> {
    if (!(await this.exists())) return emptyConfig(new Date().toISOString());
    try {
      const { data } = await readJsonWithRecovery<ContinuumConfig>(this.filePath);
      if (data.schemaVersion > CONFIG_SCHEMA_VERSION) {
        throw new ConfigCorruptionError(`unsupported schema version ${data.schemaVersion}`);
      }
      return data;
    } catch (err) {
      if (err instanceof ConfigCorruptionError) throw err;
      throw new ConfigCorruptionError(err instanceof Error ? err.message : String(err));
    }
  }

  async save(config: ContinuumConfig): Promise<void> {
    await atomicWriteJson(this.filePath, config);
  }
}
