/**
 * Read the package version from package.json at runtime (so `continuum --version`
 * always matches the installed package, never a hardcoded phase string).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/
    const root = join(here, ".."); // package root (dist/ and package.json are siblings)
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
