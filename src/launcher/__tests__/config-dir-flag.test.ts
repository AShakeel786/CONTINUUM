/**
 * `ensureConfigDirSettingsFlag` — the provider-scoped settings.json seeding
 * that pre-accepts Claude Code's one-time bypass-permissions confirmation.
 * Fixtures only: a temp dir, never the real home directory.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfigDirOnboardingState, ensureConfigDirProjectTrust, ensureConfigDirSettingsFlag, resolveConfigDir } from "../config-dir.js";

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

  it("seeds only isolated Claude onboarding completion and derives its version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cont-configdir-"));
    const file = join(dir, ".claude.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify({ firstStartVersion: "2.1.245", machineID: "isolated" }), "utf8");

    await ensureConfigDirOnboardingState(dir);

    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(parsed.hasCompletedOnboarding).toBe(true);
    expect(parsed.lastOnboardingVersion).toBe("2.1.245");
    expect(parsed.machineID).toBe("isolated");
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  });

  it("seeds only the isolated workspace-trust marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cont-configdir-"));
    await ensureConfigDirProjectTrust(dir, "/safe/workspace");
    const parsed = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as { projects: Record<string, Record<string, unknown>> };
    expect(parsed.projects["/safe/workspace"]).toEqual({ hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 });
  });
});
