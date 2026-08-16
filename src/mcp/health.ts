/**
 * MCP functional health — goes beyond "is it registered" to actually launch
 * the `continuum-mcp` stdio server and complete an `initialize` handshake.
 * Distinguishes, for the doctor, whether the server is reachable, the binary
 * is missing, the path is stale, or the protocol is broken. Read-only; never
 * writes to the user's CLI config and never emits a secret.
 */

import { spawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import type { McpShell } from "./registration.js";

export type McpHealthStatus = "reachable" | "protocol-failure" | "executable-missing" | "stale-path";

export interface McpHealthResult {
  readonly status: McpHealthStatus;
  readonly detail: string;
}

export interface McpHealthDeps {
  readonly exists?: (path: string) => Promise<boolean>;
  readonly handshake?: (command: readonly string[]) => Promise<"reachable" | "protocol-failure" | "executable-missing">;
}

const HANDSHAKE_TIMEOUT_MS = 5000;

/** Real initialize handshake over stdio (default). */
async function realHandshake(command: readonly string[]): Promise<"reachable" | "protocol-failure" | "executable-missing"> {
  return new Promise((resolve) => {
    const [exe, ...args] = command;
    let child;
    try {
      child = spawn(exe!, [...args], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      resolve("executable-missing");
      return;
    }

    let settled = false;
    const finish = (v: "reachable" | "protocol-failure" | "executable-missing") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => finish("protocol-failure"), HANDSHAKE_TIMEOUT_MS);

    child.on("error", () => finish("executable-missing"));

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      try {
        const msg = JSON.parse(line) as { id?: unknown; error?: unknown; result?: unknown };
        if (msg && typeof msg === "object" && (msg.id === 1 || msg.id === "1")) {
          finish(msg.error ? "protocol-failure" : "reachable");
        } else {
          finish("protocol-failure");
        }
      } catch {
        finish("protocol-failure");
      }
    });

    const req = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "continuum-doctor", version: "1" } },
    });
    child.stdin?.write(req + "\n");
  });
}

/** Verify the CONTINUUM MCP stdio server is actually reachable (functional), not merely registered. */
export async function verifyMcpHealth(command: readonly string[], deps: McpHealthDeps = {}): Promise<McpHealthResult> {
  // A node+script command's second element is the script path; a missing script = stale path.
  if (command.length >= 2 && command[0]!.includes("node")) {
    const scriptPath = command[1]!;
    const exists = deps.exists ?? (async (p) => {
      try {
        await fsPromises.access(p);
        return true;
      } catch {
        return false;
      }
    });
    if (!(await exists(scriptPath))) {
      return { status: "stale-path", detail: `MCP server script missing: ${scriptPath}` };
    }
  }

  const handshake = deps.handshake ?? realHandshake;
  const outcome = await handshake(command);
  switch (outcome) {
    case "reachable":
      return { status: "reachable", detail: "initialize handshake ok" };
    case "executable-missing":
      return { status: "executable-missing", detail: "MCP server executable failed to launch" };
    default:
      return { status: "protocol-failure", detail: "MCP server responded but the initialize handshake failed" };
  }
}

/** Convenience: the shell used to detect registration (re-exported shape). */
export type { McpShell };
