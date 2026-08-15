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

export function spawnCli(plan: LaunchPlan): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };
    for (const v of plan.clearEnvVars) delete env[v];
    if (plan.configDir) env.CLAUDE_CONFIG_DIR = plan.configDir;

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
