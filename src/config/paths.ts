/**
 * CONTINUUM's own data directory — distinct from Phase 5's per-task
 * session directory (`src/session/`, a caller-supplied `baseDir`). This is
 * global, machine-level state: which credential backend is selected, and
 * (for the encrypted-file fallback only) the credential vault itself.
 *
 * Never assumes a specific username or install location (Phase 6 brief
 * §8, "fresh-machine" requirement) — resolved from `os.homedir()` plus an
 * optional `CONTINUUM_HOME` override, the same override-then-default
 * pattern used throughout this codebase (env-var-first, sensible default).
 */

import os from "node:os";
import path from "node:path";

export function resolveDataDir(): string {
  const override = process.env.CONTINUUM_HOME?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".continuum");
}

export function resolveConfigFilePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, "config.json");
}

export function resolveVaultFilePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, "vault.enc.json");
}
