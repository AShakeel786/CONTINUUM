/**
 * Claude auth metadata + CLI adapter. Grounded in the real, installed
 * `claude` CLI on this machine (live-verified read-only this phase — see
 * docs/PHASE_6_SECURITY_REPORT.md for exactly what was and wasn't run):
 *   - `claude --version` → real version string, exit 0.
 *   - `claude auth --help` → confirms `login`/`logout`/`status` subcommands.
 *   - `claude auth status` → real JSON, e.g. `{"loggedIn": true, "authMethod": ...}`.
 * Login/logout were deliberately never invoked against the real
 * installation this phase — this IS the CLI this session runs inside;
 * disrupting its live authentication would be actively harmful, not just
 * out of scope. See the security report for how login/logout were instead
 * verified (a fake executable, not the real `claude` binary).
 */

import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import type { CliAuthAdapter, CliAuthStatus, ProviderAuthMetadata } from "../types.js";

export const claudeAuthMetadata: ProviderAuthMetadata = {
  providerId: "claude",
  api: { supported: true, envVar: "ANTHROPIC_API_KEY" },
  cli: {
    supported: true,
    executable: "claude",
    versionArgs: ["--version"],
    statusArgs: ["auth", "status"],
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
  },
};

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
