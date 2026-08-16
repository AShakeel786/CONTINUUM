/**
 * User provider manifest store — `~/.continuum/providers/<id>.json`.
 * Plain, readable JSON (not the checksum-enveloped atomic format) so a user
 * can inspect or hand-edit a manifest; writes are still write-temp-then-rename
 * to avoid a torn file. Only the manifest *metadata* lives here — credentials
 * stay in `CredentialManager`.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDataDir } from "../config/paths.js";
import { validateManifest, type ProviderManifest } from "./manifest.js";

export function providersDir(dataDir: string = resolveDataDir()): string {
  return join(dataDir, "providers");
}

export interface ManifestLoadResult {
  readonly manifests: readonly ProviderManifest[];
  readonly errors: readonly { readonly file: string; readonly errors: readonly string[] }[];
}

/** Load all user manifests, returning the valid ones plus per-file validation errors. */
export async function loadUserManifests(dataDir: string = resolveDataDir()): Promise<ManifestLoadResult> {
  const dir = providersDir(dataDir);
  const manifests: ProviderManifest[] = [];
  const errors: { file: string; errors: readonly string[] }[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { manifests, errors }; // no dir yet
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const errs = validateManifest(parsed);
      if (errs.length > 0) {
        errors.push({ file: entry, errors: errs });
      } else {
        manifests.push(parsed as ProviderManifest);
      }
    } catch (err) {
      errors.push({ file: entry, errors: [err instanceof Error ? err.message : String(err)] });
    }
  }
  return { manifests, errors };
}

/** Write a manifest (atomic via temp+rename). */
export async function saveUserManifest(manifest: ProviderManifest, dataDir: string = resolveDataDir()): Promise<void> {
  const dir = providersDir(dataDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${manifest.id}.json`);
  const tmp = join(dir, `.${manifest.id}.json.tmp-${process.pid}`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

/** Remove a user manifest by id. Returns false if it didn't exist. */
export async function deleteUserManifest(id: string, dataDir: string = resolveDataDir()): Promise<boolean> {
  const file = join(providersDir(dataDir), `${id}.json`);
  try {
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Convenience: expand `~` in a path (used by CLI helpers). */
export function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? ".";
  if (p.startsWith("~/")) return join(process.env.HOME ?? ".", p.slice(2));
  return p;
}

export { validateManifest };
