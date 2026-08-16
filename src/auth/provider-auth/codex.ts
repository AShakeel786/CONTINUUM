/**
 * Codex auth metadata + CLI adapter. Metadata derived from the bundled
 * `codexManifest`; the adapter keeps Codex's stderr-based status parser.
 */

import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import type { CliAuthAdapter, CliAuthStatus, ProviderAuthMetadata } from "../types.js";
import { manifestToAuthMetadata } from "../../providers/manifest.js";
import { codexManifest } from "../../providers/presets.js";

export const codexAuthMetadata: ProviderAuthMetadata = manifestToAuthMetadata(codexManifest);

/** `codex login status` prints to stderr; parse both streams case-insensitively. */
export function parseCodexAuthStatus(stdout: string, stderr = ""): CliAuthStatus {
  const s = `${stdout}\n${stderr}`.toLowerCase();
  if (s.includes("not logged in")) return "not-authenticated";
  if (s.includes("logged in")) return "authenticated";
  return "unknown";
}

export function createCodexCliAuthAdapter(): CliAuthAdapter {
  if (!codexAuthMetadata.cli.supported) throw new Error("unreachable: codexAuthMetadata.cli always supports CLI auth");
  return createCliAuthAdapter("codex", codexAuthMetadata.cli, {
    parseStatus: (stdout, stderr) => parseCodexAuthStatus(stdout, stderr),
  });
}
