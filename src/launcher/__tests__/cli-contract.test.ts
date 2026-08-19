import { describe, expect, it } from "vitest";
import { verifyCliContract, type CliShell } from "../cli-contract.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { antigravityProfile } from "../../providers/profiles/antigravity.js";

class FakeShell implements CliShell {
  constructor(private readonly help: string, private readonly versionOk = true) {}
  async run(cmd: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (args[0] === "--version") return { code: this.versionOk ? 0 : 1, stdout: "v", stderr: "" };
    if (args[0] === "--help") return { code: 0, stdout: this.help, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("verifyCliContract", () => {
  it("passes when the declared resume + session-id + context-delivery + mcp-supply flags appear in --help", async () => {
    const help = "Usage: claude\n  -r, --resume [value]\n  --session-id <uuid>\n  --append-system-prompt <prompt>\n  --mcp-config <configs...>\n";
    const check = await verifyCliContract(new FakeShell(help), createProviderAdapter(claudeProfile));
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("--resume");
  });

  it("passes Codex when `resume` subcommand + model/bypass flags appear in --help (no session-id, no mcp flag declared)", async () => {
    const help =
      "Options:\n  -m, --model <model>  Model to use\n  --dangerously-bypass-approvals-and-sandbox  Skip approval+sandbox\nCommands:\n  resume  Resume a previous interactive session\n  exec  Run non-interactively\n";
    const check = await verifyCliContract(new FakeShell(help), createProviderAdapter(codexProfile));
    expect(check.ok).toBe(true);
  });

  it("fails clearly on CLI drift (resume flag missing)", async () => {
    const help = "Usage: claude\n  (no resume flag here)\n  --append-system-prompt <prompt>\n  --mcp-config <configs...>\n";
    const check = await verifyCliContract(new FakeShell(help), createProviderAdapter(claudeProfile));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("CLI drift");
    expect(check.detail).toContain("--resume");
  });

  it("fails clearly when the declared context-delivery flag drifts (--append-system-prompt missing)", async () => {
    const help = "Usage: claude\n  -r, --resume [value]\n  --session-id <uuid>\n  --mcp-config <configs...>\n  (no append-system-prompt)\n";
    const check = await verifyCliContract(new FakeShell(help), createProviderAdapter(claudeProfile));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("CLI drift");
    expect(check.detail).toContain("--append-system-prompt");
  });

  it("fails clearly when the declared mcp-supply flag drifts (--mcp-config missing)", async () => {
    const help = "Usage: claude\n  -r, --resume [value]\n  --session-id <uuid>\n  --append-system-prompt <prompt>\n  (no mcp-config)\n";
    const check = await verifyCliContract(new FakeShell(help), createProviderAdapter(claudeProfile));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("CLI drift");
    expect(check.detail).toContain("--mcp-config");
  });

  it("fails when the CLI is not installed (--version fails)", async () => {
    const check = await verifyCliContract(new FakeShell("", false), createProviderAdapter(claudeProfile));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not installed");
  });

  it("passes Antigravity when `--conversation` + model/bypass flags appear in `agy --help`", async () => {
    const help =
      "Usage of agy:\n  --conversation  Resume a previous conversation by ID\n  --model  Model for the current CLI session\n  --dangerously-skip-permissions  Run without approval prompts\n";
    const check = await verifyCliContract(new FakeShell(help), createProviderAdapter(antigravityProfile));
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("--conversation");
  });

  it("fails clearly when the declared Antigravity resume flag drifts (--conversation missing)", async () => {
    const help = "Usage of agy:\n  --continue  Continue the most recent conversation\n  --model  Model for the current CLI session\n  --dangerously-skip-permissions  Run without approval prompts\n";
    const check = await verifyCliContract(new FakeShell(help), createProviderAdapter(antigravityProfile));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("CLI drift");
    expect(check.detail).toContain("--conversation");
  });
});
