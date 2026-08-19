/**
 * Antigravity auth metadata + CLI adapter. Metadata is derived from the
 * bundled `antigravityManifest`; the adapter keeps Antigravity's LOCAL,
 * non-secret auth detection.
 *
 * `agy` exposes no `auth status`/`login status` subcommand, so
 * authenticated-ness is read from `~/.gemini/google_accounts.json` — the
 * active-account EMAIL (account metadata, not a credential). CONTINUUM never
 * opens `oauth_creds.json`, never reads the keyring token, and never
 * stores/copies any credential. It only needs "has a Google session been
 * recorded for this CLI?".
 *
 * Re-audit finding (2026-08-19): the actual runtime auth is the macOS keyring
 * (`agy`'s own `ChainedAuth → keyring`), and `oauth_creds.json` is a secondary
 * cache that can drift from the keyring across silent token refreshes. The
 * account's `#3501 SUBSCRIPTION_REQUIRED` signal seen earlier came from the
 * Gemini Code Assist `retrieveUserQuotaSummary` endpoint (domain
 * `cloudaicompanion.googleapis.com`) — a SEPARATE product's enterprise
 * entitlement, not the Antigravity Individual tier. It is not a local,
 * stable licensing signal, so CONTINUUM deliberately does NOT gate usability
 * on it. Entitlement + quota are runtime-server concerns that `agy` itself
 * surfaces via its own exit code / error text.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliAuthAdapter, CliAuthStatus, CliInstalledStatus, CliLoginResult, ProviderAuthMetadata } from "../types.js";
import { manifestToAuthMetadata } from "../../providers/manifest.js";
import { antigravityManifest } from "../../providers/presets.js";

export const antigravityAuthMetadata: ProviderAuthMetadata = manifestToAuthMetadata(antigravityManifest);

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5000;

/** Where Antigravity keeps its local (non-secret) account state. Injectable for tests. */
export interface AntigravityAuthPaths {
  /** Root directory (defaults to `~/.gemini`). */
  readonly geminiDir?: string;
}

function resolveGeminiDir(paths?: AntigravityAuthPaths): string {
  return paths?.geminiDir ?? join(homedir(), ".gemini");
}

/**
 * Read the active Google account email (metadata only — an account identifier,
 * not a credential). Returns undefined when absent/empty/unparseable.
 */
export async function readActiveAccount(geminiDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(geminiDir, "google_accounts.json"), "utf8");
    const parsed = JSON.parse(raw) as { active?: unknown };
    return typeof parsed.active === "string" && parsed.active.trim().length > 0 ? parsed.active.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Local, side-effect-free authenticated check. A Google session is considered
 * recorded when `google_accounts.json` names an active account — the stable
 * "a user signed in" signal. Token expiry is deliberately NOT consulted:
 * the authoritative token lives in the macOS keyring (which CONTINUUM must
 * not read) and agy silently refreshes it, so an `oauth_creds.json` expiry
 * check would only risk a false "not-authenticated" when the two drift.
 * Entitlement/quota remain runtime concerns surfaced by agy itself.
 */
export async function detectAntigravityAuthenticated(paths?: AntigravityAuthPaths): Promise<CliAuthStatus> {
  const geminiDir = resolveGeminiDir(paths);
  const account = await readActiveAccount(geminiDir);
  return account ? "authenticated" : "not-authenticated";
}

function runInteractive(executable: string, args: string[]): Promise<CliLoginResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ completed: exitCode === 0, exitCode }));
  });
}

export function createAntigravityCliAuthAdapter(paths?: AntigravityAuthPaths): CliAuthAdapter {
  if (!antigravityAuthMetadata.cli.supported) throw new Error("unreachable: antigravityAuthMetadata.cli always supports CLI auth");
  const capability = antigravityAuthMetadata.cli;
  return {
    providerId: "antigravity",
    capability,

    async detectInstalled(): Promise<CliInstalledStatus> {
      try {
        await execFileAsync(capability.executable, [...capability.versionArgs], { timeout: DETECT_TIMEOUT_MS });
        return "installed";
      } catch {
        return "not-installed";
      }
    },

    async detectAuthenticated(): Promise<CliAuthStatus> {
      return detectAntigravityAuthenticated(paths);
    },

    async login(): Promise<CliLoginResult> {
      // No `agy login` subcommand: bare `agy` opens the interactive Google OAuth
      // flow when not signed in. CONTINUUM inherits stdio and never sees the
      // token exchange.
      return runInteractive(capability.executable, []);
    },

    async logout(): Promise<CliLoginResult | undefined> {
      // No `agy logout` subcommand; auth removal is outside CONTINUUM's scope.
      return undefined;
    },
  };
}
