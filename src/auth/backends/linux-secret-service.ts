/**
 * Linux native credential backend — the Secret Service D-Bus API, via the
 * `secret-tool` CLI (part of `libsecret-tools`, common on GNOME-based
 * distros; not guaranteed present, especially headless/server Linux —
 * `isAvailable()` genuinely checks rather than assuming).
 *
 * NOT live-tested this phase (no Linux machine available in this
 * environment) — implemented from `secret-tool`'s documented contract;
 * treat as unverified until run on real Linux with a Secret Service
 * provider (GNOME Keyring, KWallet's Secret Service shim, etc.) actually
 * running. See docs/PHASE_6_SECURITY_REPORT.md.
 *
 * Unlike the macOS backend, `secret-tool store` genuinely reads the secret
 * from stdin — no argv exposure here.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialBackend } from "../types.js";
import { assertNotUnderTest } from "./test-guard.js";

const execFileAsync = promisify(execFile);
const ATTRIBUTE_KEY = "continuum-key";

function storeViaStdin(key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", ["store", "--label", `CONTINUUM: ${key}`, ATTRIBUTE_KEY, key], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`secret-tool store exited ${code}: ${stderr.trim()}`))));
    child.stdin.write(value, "utf8");
    child.stdin.end();
  });
}

export class LinuxSecretServiceCredentialBackend implements CredentialBackend {
  readonly id = "linux-secret-service";
  readonly securityLevel = "os-native" as const;
  readonly description =
    "Linux Secret Service (via `secret-tool` / libsecret) — GNOME Keyring or an equivalent provider, tied " +
    "to your login session/keyring password.";

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    try {
      await execFileAsync("secret-tool", ["--version"]);
      return true;
    } catch {
      // Absent binary, or no Secret Service provider reachable (e.g. headless, no D-Bus session).
      return false;
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertNotUnderTest(this.id, "set");
    await storeViaStdin(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("secret-tool", ["lookup", ATTRIBUTE_KEY, key]);
      const value = stdout.replace(/\n$/, "");
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    assertNotUnderTest(this.id, "delete");
    try {
      await execFileAsync("secret-tool", ["clear", ATTRIBUTE_KEY, key]);
    } catch {
      // Clearing a nonexistent item is a no-op from the caller's perspective.
    }
  }

  async list(): Promise<readonly string[]> {
    // secret-tool has no "list all keys for attribute" query either -- same
    // rationale as the macOS backend: don't guess/scrape, degrade honestly.
    return [];
  }
}
