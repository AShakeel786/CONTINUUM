import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildMcpAddArgs, ensureMcpRegistered, isMcpRegistered, mcpServerCommand, registerMcpIfMissing, type McpShell } from "../registration.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";

class FakeShell implements McpShell {
  calls: { cmd: string; args: readonly string[] }[] = [];
  private registered = new Map<string, Set<string>>();
  private set(cmd: string, name: string): void {
    if (!this.registered.has(cmd)) this.registered.set(cmd, new Set());
    this.registered.get(cmd)!.add(name);
  }
  markRegistered(name: string, cmd = "claude"): this {
    this.set(cmd, name);
    return this;
  }
  async run(cmd: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    this.calls.push({ cmd, args });
    if (args[0] === "mcp" && args[1] === "list") {
      const names = [...(this.registered.get(cmd) ?? new Set<string>())];
      return { code: 0, stdout: names.map((n) => `${n}\t...`).join("\n"), stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      this.set(cmd, args[2]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("mcpServerCommand", () => {
  it("is a secret-free `node <abs>/dist/mcp/bin.js` command", () => {
    const cmd = mcpServerCommand();
    expect(cmd[0]).toBe(process.execPath);
    // Platform-neutral: the path is assembled with the platform separator, so
    // compare against a join-normalized tail instead of a hard-coded `/`.
    expect(cmd[1]).toContain(join("dist", "mcp", "bin.js"));
    // No tokens/keys in the generated command.
    expect(JSON.stringify(cmd)).not.toMatch(/sk-|Bearer|token=/i);
  });
});

describe("buildMcpAddArgs", () => {
  it("builds `claude mcp add continuum -- <node> <dist>` and `codex mcp add continuum -- <node> <dist>`", () => {
    const claude = buildMcpAddArgs(claudeProfile.cliLaunch);
    expect(claude).toBeDefined();
    expect(claude![0]).toBe("claude");
    expect(claude![1]).toBe("mcp");
    expect(claude![2]).toBe("add");
    expect(claude![3]).toBe("continuum");
    expect(claude![4]).toBe("--");
    expect(claude![5]).toBe(process.execPath);

    const codex = buildMcpAddArgs(codexProfile.cliLaunch);
    expect(codex![0]).toBe("codex");
    expect(codex![3]).toBe("continuum");
    expect(codex![5]).toBe(process.execPath);
  });

  it("builds for DeepSeek (proxy-routed, now declares mcp) via its claude executable", () => {
    const ds = buildMcpAddArgs(deepseekProfile.cliLaunch);
    expect(ds).toBeDefined();
    expect(ds![0]).toBe("claude"); // proxy-routed → claude executable
    expect(ds![3]).toBe("continuum");
    expect(ds![5]).toBe(process.execPath);
  });

  it("returns undefined for a descriptor with no MCP declaration", () => {
    const noMcp = { ...codexProfile.cliLaunch, mcp: undefined };
    expect(buildMcpAddArgs(noMcp)).toBeUndefined();
  });
});

describe("isMcpRegistered + registerMcpIfMissing (idempotency + no overwrite)", () => {
  it("detects an already-registered server (idempotent no-op)", async () => {
    const shell = new FakeShell().markRegistered("continuum");
    const result = await registerMcpIfMissing(shell, claudeProfile.cliLaunch);
    expect(result.status).toBe("already");
    // No `mcp add` was issued.
    expect(shell.calls.some((c) => c.args[1] === "add")).toBe(false);
  });

  it("registers when missing, then a second run is already", async () => {
    const shell = new FakeShell();
    const first = await registerMcpIfMissing(shell, codexProfile.cliLaunch);
    expect(first.status).toBe("registered");
    const second = await registerMcpIfMissing(shell, codexProfile.cliLaunch);
    expect(second.status).toBe("already");
    // Exactly one `mcp add` issued total (never rewrites unrelated config).
    expect(shell.calls.filter((c) => c.args[1] === "add")).toHaveLength(1);
  });

  it("never removes/overwrites unrelated user MCP servers", async () => {
    const shell = new FakeShell().markRegistered("user-own-server");
    await registerMcpIfMissing(shell, claudeProfile.cliLaunch);
    // The unrelated server is still present, and only ONE add (continuum) happened.
    expect(await isMcpRegistered(shell, claudeProfile.cliLaunch)).toBe(true);
    expect(shell.calls.filter((c) => c.args[1] === "add")).toHaveLength(1);
    expect(shell.calls.filter((c) => c.args[1] === "remove")).toHaveLength(0);
  });
});

describe("ensureMcpRegistered (auto-configure gating)", () => {
  const launches = [claudeProfile.cliLaunch, codexProfile.cliLaunch];

  it("registers when autoConfigure === true", async () => {
    const shell = new FakeShell();
    const results = await ensureMcpRegistered(shell, launches, true);
    expect(results).toHaveLength(2);
    expect(shell.calls.filter((c) => c.args[1] === "add")).toHaveLength(2);
  });

  it("does nothing when autoConfigure === false or undefined", async () => {
    const shell = new FakeShell();
    expect(await ensureMcpRegistered(shell, launches, false)).toEqual([]);
    expect(await ensureMcpRegistered(shell, launches, undefined)).toEqual([]);
    expect(shell.calls.filter((c) => c.args[1] === "add")).toHaveLength(0);
  });
});
