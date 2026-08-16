/**
 * MCP auto-connect — generates and (idempotently) applies the CLI-level MCP
 * registration that points Claude/Codex at the existing `continuum-mcp` stdio
 * server. Provider-independent: the registration shape is identical for both
 * (`<cli> mcp add <name> -- <command>...`), driven by the `cliLaunch.executable`
 * already in the profile + the declared `mcp.serverName`.
 *
 * - Reuses the existing `continuum-mcp` stdio server (no new server).
 * - Idempotent: adds only if not already registered; never touches unrelated
 *   user MCP servers (the CLI's own `mcp add` appends, it doesn't rewrite).
 * - No secrets: the generated command is `node <abs path>` — no tokens.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliLaunchDescriptor } from "../providers/types.js";

/** Minimal shell runner (injectable for tests). */
export interface McpShell {
  run(cmd: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** The stdio server command: `node <projectRoot>/dist/mcp/bin.js` (absolute, secret-free). */
export function mcpServerCommand(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url)); // .../dist/mcp
  const projectRoot = join(here, "..", "..");
  const bin = join(projectRoot, "dist", "mcp", "bin.js");
  return ["node", bin];
}

/** Build `<cli> mcp add <name> -- node <dist/mcp/bin.js>` for a profile that declares MCP support. */
export function buildMcpAddArgs(launch: CliLaunchDescriptor): readonly string[] | undefined {
  const mcp = launch.mcp;
  if (!mcp || !mcp.supported) return undefined;
  return [launch.executable, "mcp", "add", mcp.serverName, "--", ...mcpServerCommand()];
}

/** True when the declared server name already appears in `<cli> mcp list` output. */
export async function isMcpRegistered(shell: McpShell, launch: CliLaunchDescriptor): Promise<boolean> {
  const mcp = launch.mcp;
  if (!mcp || !mcp.supported) return false;
  const res = await shell.run(launch.executable, ["mcp", "list"]);
  return res.stdout.includes(mcp.serverName);
}

export interface McpRegistrationResult {
  readonly serverName: string;
  /** "registered" (added now) | "already" (present) | "unsupported" (no declared mcp). */
  readonly status: "registered" | "already" | "unsupported";
  readonly detail: string;
}

/** Idempotently register the CONTINUUM MCP server for a provider, without overwriting unrelated config. */
export async function registerMcpIfMissing(shell: McpShell, launch: CliLaunchDescriptor): Promise<McpRegistrationResult> {
  const mcp = launch.mcp;
  if (!mcp || !mcp.supported) {
    return { serverName: "", status: "unsupported", detail: "no MCP auto-connect declared" };
  }
  if (await isMcpRegistered(shell, launch)) {
    return { serverName: mcp.serverName, status: "already", detail: "already registered" };
  }
  const args = buildMcpAddArgs(launch)!;
  const res = await shell.run(args[0]!, args.slice(1));
  if (res.code !== 0) {
    return { serverName: mcp.serverName, status: "unsupported", detail: `register failed: ${firstLine(res.stderr) || firstLine(res.stdout)}` };
  }
  return { serverName: mcp.serverName, status: "registered", detail: "registered" };
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}
