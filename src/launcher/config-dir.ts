/**
 * Native CLI config-dir resolution. Provider profiles declare a bare config
 * *name* (`.claude-tencent`, `.claude-anthropic`) — the Claude-family CLI reads
 * it via `CLAUDE_CONFIG_DIR`. A relative value makes Claude Code resolve it
 * against the spawned `cwd` (the project repo), silently creating a fresh,
 * empty `.claude-*` directory *inside the repo* with no MCP servers and no
 * user `CLAUDE.md`. Resolving against `$HOME` before spawn closes that gap
 * (the dogfood audit's second root cause).
 *
 * Idempotent: an already-absolute path is returned verbatim; `~/…` is
 * expanded; a bare name is joined onto `os.homedir()`.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export function resolveConfigDir(configDirName: string | undefined): string | undefined {
  if (!configDirName) return undefined;
  if (configDirName === "~") return homedir();
  if (configDirName.startsWith("~/")) return join(homedir(), configDirName.slice(2));
  if (isAbsolute(configDirName)) return configDirName;
  return join(homedir(), configDirName);
}

/**
 * Ensure a settings flag exists in a RESOLVED provider config dir's
 * `settings.json` — used to pre-accept Claude Code's one-time
 * bypass-permissions confirmation (`skipDangerousModePermissionPrompt`)
 * inside CONTINUUM's OWN isolated config dir (e.g. `.claude-deepseek`).
 * Never touches the user's global `~/.claude/settings.json`: the path
 * passed in is always a provider-scoped config dir CONTINUUM created.
 * Best-effort and idempotent — failures never block a launch.
 */
export async function ensureConfigDirSettingsFlag(
  configDir: string,
  key: string,
  value: unknown,
): Promise<void> {
  try {
    const file = join(configDir, "settings.json");
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(file, "utf8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No settings.json yet — start fresh.
    }
    const nextRecord = { ...existing, [key]: value };
    if (JSON.stringify(existing) === JSON.stringify(nextRecord)) return;
    const next = JSON.stringify(nextRecord, null, 2);
    await mkdir(configDir, { recursive: true });
    await writeFile(file, next, "utf8");
  } catch {
    // Advisory only.
  }
}

/** Pre-accept Claude Code's first-run onboarding in the isolated config. */
export async function ensureConfigDirOnboardingState(configDir: string): Promise<void> {
  try {
    const file = join(configDir, ".claude.json");
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      // No isolated Claude state yet — start fresh.
    }
    const nextRecord: Record<string, unknown> = { ...existing, hasCompletedOnboarding: true };
    if (typeof existing.lastOnboardingVersion !== "string" && typeof existing.firstStartVersion === "string" && existing.firstStartVersion.length > 0) {
      nextRecord.lastOnboardingVersion = existing.firstStartVersion;
    }
    if (JSON.stringify(existing) === JSON.stringify(nextRecord)) return;
    await mkdir(configDir, { recursive: true });
    await writeFile(file, JSON.stringify(nextRecord, null, 2), "utf8");
  } catch {
    // Advisory only.
  }
}

/**
 * Pre-accept Claude Code's workspace-trust screen in CONTINUUM's isolated
 * provider config. Only the trust marker is written; MCP definitions,
 * credentials, sessions, and runtime telemetry are never copied.
 */
export async function ensureConfigDirProjectTrust(configDir: string, projectPath: string): Promise<void> {
  try {
    const file = join(configDir, ".claude.json");
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      // No isolated Claude state yet — start fresh.
    }
    const projects = existing.projects && typeof existing.projects === "object" && !Array.isArray(existing.projects)
      ? (existing.projects as Record<string, unknown>)
      : {};
    const current = projects[projectPath] && typeof projects[projectPath] === "object" && !Array.isArray(projects[projectPath])
      ? (projects[projectPath] as Record<string, unknown>)
      : {};
    const nextProject = {
      ...current,
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: typeof current.projectOnboardingSeenCount === "number" ? current.projectOnboardingSeenCount : 1,
    };
    const nextRecord = { ...existing, projects: { ...projects, [projectPath]: nextProject } };
    if (JSON.stringify(existing) === JSON.stringify(nextRecord)) return;
    const next = JSON.stringify(nextRecord, null, 2);
    await mkdir(configDir, { recursive: true });
    await writeFile(file, next, "utf8");
  } catch {
    // Advisory only.
  }
}
