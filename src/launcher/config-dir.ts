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

export function resolveConfigDir(configDirName: string | undefined): string | undefined {
  if (!configDirName) return undefined;
  if (configDirName === "~") return homedir();
  if (configDirName.startsWith("~/")) return join(homedir(), configDirName.slice(2));
  if (isAbsolute(configDirName)) return configDirName;
  return join(homedir(), configDirName);
}
