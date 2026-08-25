/**
 * `ensureConfigDirSettingsFlag` — the provider-scoped settings.json seeding
 * that pre-accepts Claude Code's one-time bypass-permissions confirmation.
 * Fixtures only: a temp dir, never the real home directory.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfigDirSettingsFlag, resolveConfigDir } from "../config-dir.js";

describe("ensureConfigDirSettingsFlag", () => {
  it("creates the config dir + settings.json with the flag when none exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cont-configdir-"));
    await ensureConfigDirSettingsFlag(dir, "skipDangerousModePermissionPrompt", true);
    const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
  });

  it("merges into an existing settings.json without clobbering other keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cont-configdir-"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify({ theme: "dark" }), "utf8");
    await ensureConfigDirSettingsFlag(dir, "skipDangerousModePermissionPrompt", true);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
  });

  it("is idempotent and never blocks on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cont-configdir-"));
    await ensureConfigDirSettingsFlag(dir, "skipDangerousModePermissionPrompt", true);
    await ensureConfigDirSettingsFlag(dir, "skipDangerousModePermissionPrompt", true);
    // A path that can never be created (a file in the way) must not throw.
    const file = join(dir, "blocker");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "x", "utf8");
    await expect(ensureConfigDirSettingsFlag(file, "skipDangerousModePermissionPrompt", true)).resolves.toBeUndefined();
  });

  it("resolveConfigDir keeps expanding bare names against the home dir (no behavior change)", () => {
    expect(resolveConfigDir(undefined)).toBeUndefined();
    expect(resolveConfigDir("/abs/path")).toBe("/abs/path");
  });
});
