import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolve the built server entrypoint; tests run against dist/ after `npm run build`.
// Fall back to src via tsx-free path is avoided: we require `npm run build` before tests in the workflow.

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const BIN = path.join(REPO_ROOT, "dist", "mcp", "bin.js");

/** Spawns the real MCP server and pipes JSON-RPC lines, reading exactly N responses. */
function runStdio(lines: string[], count: number, env: Record<string, string> = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const responses: string[] = [];
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      // Split complete lines.
      while (out.includes("\n")) {
        const idx = out.indexOf("\n");
        responses.push(out.slice(0, idx));
        out = out.slice(idx + 1);
        if (responses.length >= count) {
          child.kill();
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => {
      if (responses.length < count) reject(new Error(`server closed early; got ${responses.length}/${count}; stderr: ${stderr}`));
      else resolve(responses);
    });
    for (const line of lines) child.stdin.write(line + "\n");
    child.stdin.end();
  });
}

describe("MCP stdio transport (real subprocess)", () => {
  it("speaks line-delimited JSON-RPC over stdio and degrades when MemoryCore is unset", async () => {
    const responses = await runStdio(
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_recall","arguments":{}}}',
      ],
      2,
      { CONTINUUM_HOME: path.join(REPO_ROOT, "node_modules", ".tmp-mcp-stdio"), CONTINUUM_MEMORY_CORE_URL: "", CONTINUUM_MEMORY_CORE_TOKEN: "", CONTINUUM_MEMORY_CORE_ENV_ONLY: "1" },
    );
    const init = JSON.parse(responses[0]!);
    expect(init.result.serverInfo.name).toBe("continuum");
    const call = JSON.parse(responses[1]!);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("not configured");
  });

  it("handles a parse error without crashing (returns a JSON-RPC error)", async () => {
    const responses = await runStdio(["this is not json"], 1, { CONTINUUM_HOME: path.join(REPO_ROOT, "node_modules", ".tmp-mcp-stdio2") });
    const err = JSON.parse(responses[0]!);
    expect(err.error.code).toBe(-32700);
  });
});
