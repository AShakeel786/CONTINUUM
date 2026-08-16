/**
 * Codex auth metadata + CLI adapter. Grounded in the real, installed `codex`
 * CLI on this machine (live-verified read-only this phase):
 *   - `codex --version` → "codex-cli 0.147.0", exit 0.
 *   - `codex login status` → "Logged in using ChatGPT", exit 0.
 *   - `codex login` / `codex logout` exist as subcommands.
 * Login/logout are deliberately never invoked against the real installation:
 * Codex authenticates via its own OAuth/device flow and its own
 * `~/.codex/auth.json`; CONTINUUM only detects the existing session, it never
 * copies or stores the tokens.
 */

import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import type { CliAuthAdapter, CliAuthStatus, ProviderAuthMetadata } from "../types.js";

export const codexAuthMetadata: ProviderAuthMetadata = {
  providerId: "codex",
  // No API-key auth here: Codex is reached through its native CLI session.
  api: { supported: false },
  cli: {
    supported: true,
    executable: "codex",
    versionArgs: ["--version"],
    statusArgs: ["login", "status"],
    loginArgs: ["login"],
    logoutArgs: ["logout"],
  },
};

/**
 * `codex login status` prints "Logged in using <method>" when authenticated
 * and "Not logged in." otherwise — and, crucially, writes it to *stderr*,
 * not stdout. Parse both streams case-insensitively and never guess from
 * unparseable output.
 */
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
