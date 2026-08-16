/**
 * Generic CLI-auth behavior, driven entirely by `CliAuthCapability` data —
 * no provider-specific process-spawning logic lives here. The one
 * per-provider extension point is `parseStatus`, because different CLIs
 * report auth status differently (some via exit code, some via JSON on
 * stdout regardless of exit code) and guessing wrong would misreport a
 * real security-relevant state; a provider that doesn't supply one gets
 * the honest generic fallback (exit code only), never a guessed parser.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { CliAuthAdapter, CliAuthCapability, CliAuthStatus, CliInstalledStatus, CliLoginResult } from "./types.js";

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5000;
const STATUS_TIMEOUT_MS = 8000;

export type StatusParser = (stdout: string, stderr: string, exitCode: number) => CliAuthStatus;

export interface CreateCliAuthAdapterOptions {
  readonly parseStatus?: StatusParser;
}

export function createCliAuthAdapter(
  providerId: string,
  capability: CliAuthCapability,
  options: CreateCliAuthAdapterOptions = {},
): CliAuthAdapter {
  return {
    providerId,
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
      if (!capability.statusArgs) return "unknown";
      try {
        const { stdout, stderr } = await execFileAsync(capability.executable, [...capability.statusArgs], {
          timeout: STATUS_TIMEOUT_MS,
        });
        if (options.parseStatus) return options.parseStatus(stdout, stderr, 0);
        return "authenticated"; // generic fallback: exit 0 with no parser configured
      } catch (err) {
        const exitCode = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
        const stdout = typeof (err as { stdout?: unknown }).stdout === "string" ? (err as { stdout: string }).stdout : "";
        const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr : "";
        if (options.parseStatus) {
          try {
            return options.parseStatus(stdout, stderr, exitCode);
          } catch {
            return "unknown";
          }
        }
        return "not-authenticated"; // generic fallback: nonzero exit with no parser configured
      }
    },

    async login(): Promise<CliLoginResult> {
      return runInteractive(capability.executable, [...capability.loginArgs]);
    },

    async logout(): Promise<CliLoginResult | undefined> {
      if (!capability.logoutArgs) return undefined;
      return runInteractive(capability.executable, [...capability.logoutArgs]);
    },
  };
}

/** Inherits stdio so the CLI's own real interactive/OAuth/browser flow runs untouched — CONTINUUM never sees the token exchange. */
function runInteractive(executable: string, args: string[]): Promise<CliLoginResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ completed: exitCode === 0, exitCode }));
  });
}
