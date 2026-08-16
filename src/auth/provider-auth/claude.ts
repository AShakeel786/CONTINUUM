/**
 * Claude auth metadata + CLI adapter. Metadata is derived from the bundled
 * `claudeManifest`; the adapter keeps Claude's JSON `loggedIn` status parser.
 * Login/logout are never invoked against the real installation (see Phase 6).
 */

import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import type { CliAuthAdapter, CliAuthStatus, ProviderAuthMetadata } from "../types.js";
import { manifestToAuthMetadata } from "../../providers/manifest.js";
import { claudeManifest } from "../../providers/presets.js";

export const claudeAuthMetadata: ProviderAuthMetadata = manifestToAuthMetadata(claudeManifest);

function parseClaudeAuthStatus(stdout: string): CliAuthStatus {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn ? "authenticated" : "not-authenticated";
    return "unknown";
  } catch {
    return "unknown"; // never guess from unparseable output
  }
}

export function createClaudeCliAuthAdapter(): CliAuthAdapter {
  if (!claudeAuthMetadata.cli.supported) throw new Error("unreachable: claudeAuthMetadata.cli always supports CLI auth");
  return createCliAuthAdapter("claude", claudeAuthMetadata.cli, {
    parseStatus: (stdout) => parseClaudeAuthStatus(stdout),
  });
}
