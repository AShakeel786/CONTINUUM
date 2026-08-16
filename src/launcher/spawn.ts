/**
 * The one place a provider CLI is actually spawned. Thin and deliberate:
 * inherits stdio so the real interactive coding-agent CLI (OAuth prompt,
 * TUI, etc.) runs unchanged, applies the launch plan's env (resolved
 * credentials + config dir), and returns the child's exit code.
 *
 * Safe-by-default is enforced one level up (the Launcher refuses to build a
 * plan with `bypassPermissions` unless the caller explicitly opted in); this
 * module merely paints the process arguments it was given — it makes no
 * permission decision of its own.
 */

import { spawn } from "node:child_process";
import type { LaunchPlan } from "./types.js";
import { resolveConfigDir } from "./config-dir.js";

export function spawnCli(plan: LaunchPlan): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };
    for (const v of plan.clearEnvVars) delete env[v];
    // Resolve the config dir to an absolute home path before spawn — a
    // relative `CLAUDE_CONFIG_DIR` would make Claude Code create a fresh
    // repo-local `.claude-*` dir (no MCP, no user CLAUDE.md). Belt-and-
    // suspenders: the launcher already resolves it, but spawn is the last
    // line of defense and must never hand a relative path to the CLI.
    if (plan.configDir) env.CLAUDE_CONFIG_DIR = resolveConfigDir(plan.configDir);

    const child = spawn(plan.executable, [...plan.args], {
      cwd: plan.workingDir,
      env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code }));
  });
}

/** The default spawn function, injected as the launcher's spawn boundary in tests. */
export const defaultSpawn: (plan: LaunchPlan) => Promise<{ exitCode: number | null }> = spawnCli;
