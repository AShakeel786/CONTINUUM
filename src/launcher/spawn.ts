/**
 * The one place a provider CLI is actually spawned. Thin and deliberate:
 * inherits stdio so the real interactive coding-agent CLI (OAuth prompt,
 * TUI, etc.) runs unchanged, applies the launch plan's env (resolved
 * credentials + config dir), and returns the child's exit code.
 *
 * The permission decision is made one level up (the Launcher resolves bypass
 * vs safe and paints the flag into the plan); this module merely spawns the
 * process arguments it was given — it makes no permission decision of its own.
 */

import { spawn } from "node:child_process";
import type { LaunchPlan } from "./types.js";
import { resolveConfigDir } from "./config-dir.js";

export function spawnCli(plan: LaunchPlan): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    // Clear stale/inherited vars FIRST, then apply the plan's own env on top.
    // `clearEnvVars` exists to strip leftover values inherited from the
    // parent shell (e.g. a previously-exported ANTHROPIC_BASE_URL) — it must
    // never run after `plan.env`, or it would delete the exact redirect/proxy
    // vars a launch just set (this order previously caused every DeepSeek
    // launch to drop ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN and silently
    // fall through to native Claude behavior).
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const v of plan.clearEnvVars) delete env[v];
    Object.assign(env, plan.env);
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

/** Non-interactive capture boundary used by bounded provider smoke checks. */
export function spawnCliCaptured(plan: LaunchPlan): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const v of plan.clearEnvVars) delete env[v];
    Object.assign(env, plan.env);
    if (plan.configDir) env.CLAUDE_CONFIG_DIR = resolveConfigDir(plan.configDir);
    const child = spawn(plan.executable, [...plan.args], { cwd: plan.workingDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

/** The default spawn function, injected as the launcher's spawn boundary in tests. */
export const defaultSpawn: (plan: LaunchPlan) => Promise<{ exitCode: number | null }> = spawnCli;
