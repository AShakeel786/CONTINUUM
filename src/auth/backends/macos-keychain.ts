/**
 * macOS native credential backend — the `security` CLI (Keychain Services).
 * NOT live-tested this phase (no macOS machine available in this
 * environment) — implemented from the documented `security` CLI contract;
 * treat as unverified until run on real macOS. See
 * docs/PHASE_6_SECURITY_REPORT.md for what was and wasn't live-verified.
 *
 * ONE KNOWN, UNMITIGATED GAP, stated plainly rather than glossed over: the
 * standard `security add-generic-password` command has no stdin option for
 * the password — it must be passed via `-w <value>`, which means the
 * secret value briefly appears in this process's own argv (visible to
 * `ps`/`/proc` for the short lifetime of the `security` child process)
 * during `set()`. This is a documented limitation of macOS's `security`
 * CLI itself, not something this implementation works around — doing so
 * would require a native Keychain binding, out of scope for this phase.
 * Every *other* secret-handling path in this project avoids argv exposure;
 * this is the one exception, and it's confined to this one backend's
 * `set()` call.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialBackend } from "../types.js";
import { assertNotUnderTest } from "./test-guard.js";

const execFileAsync = promisify(execFile);
const SERVICE = "continuum";

export class MacosKeychainCredentialBackend implements CredentialBackend {
  readonly id = "macos-keychain";
  readonly securityLevel = "os-native" as const;
  readonly description =
    "macOS Keychain (via the `security` CLI). The secret briefly appears in this process's own argv during " +
    "credential set/replace — a macOS `security` CLI limitation.";

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      await execFileAsync("security", ["-h"]);
      return true;
    } catch {
      return false;
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertNotUnderTest(this.id, "set");
    // -U: update in place if an item with this account/service already exists.
    await execFileAsync("security", ["add-generic-password", "-a", key, "-s", SERVICE, "-w", value, "-U"]);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-a", key, "-s", SERVICE, "-w"]);
      return stdout.trim();
    } catch {
      return undefined; // "item not found" and any other lookup failure both surface as "no credential"
    }
  }

  async delete(key: string): Promise<void> {
    assertNotUnderTest(this.id, "delete");
    try {
      await execFileAsync("security", ["delete-generic-password", "-a", key, "-s", SERVICE]);
    } catch {
      // Deleting a nonexistent item is a no-op from the caller's perspective.
    }
  }

  async list(): Promise<readonly string[]> {
    // `security` has no direct "list accounts for a service" query; dump-keychain
    // is the closest, but parsing its verbose ACL-dump output reliably (without
    // ever touching secret values, which it does print for some entry types) is
    // exactly the kind of fragile scraping this project avoids elsewhere. Left
    // unimplemented (empty) rather than guessed at — `CredentialManager` and
    // `doctor` degrade to "cannot enumerate" for this backend, not a wrong list.
    return [];
  }
}
