import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "../build.js";
import { buildCodingTools, buildToolSurfaceBlock, CODING_TOOL_NAMES, codingToolsAvailable } from "../coding-tools.js";
import { ToolRegistry, textResult, UnknownToolError } from "../tools.js";
import { runAgentLoop } from "../../api-agent/agent.js";
import { toOpenAiTools } from "../../api-agent/format.js";
import type { ApiRunner } from "../../api-agent/runner.js";
import type { AgentTurnResult } from "../../api-agent/types.js";

/**
 * Windows requires SeCreateSymbolicLinkPrivilege (admin/Developer Mode) for
 * symlink creation; without it `symlinkSync` throws EPERM. The symlink-escape
 * isolation test below only runs when this capability actually exists — the
 * test skips explicitly rather than failing on hosts that cannot create
 * symlinks. Any non-privilege symlink error rethrows so a genuine problem is
 * never masked by the probe.
 */
function symlinksSupported(): boolean {
  const probe = join(tmpdir(), `continuum-symlink-probe-${process.pid}.txt`);
  try {
    writeFileSync(probe, "");
    symlinkSync(probe, `${probe}.link`);
    unlinkSync(`${probe}.link`);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "EPERM" || code === "EACCES") return false; // capability absent → skip
    throw err; // anything else is a real environment problem, not a skip
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // probe cleanup best-effort
    }
  }
}

function tmpProject(): { dir: string; outside: string } {
  const parent = mkdtempSync(join(tmpdir(), "coding-proj-parent-"));
  const dir = join(parent, "proj");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), "export function main() { return 1; }\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  const outside = join(parent, "outside.txt");
  writeFileSync(outside, "secret outside content\n");
  return { dir, outside };
}

async function registry(projectPath?: string): Promise<ToolRegistry> {
  return buildToolRegistry({
    dataDir: mkdtempSync(join(tmpdir(), "coding-reg-")),
    memoryProvider: async () => undefined,
    ...(projectPath ? { coding: { projectPath } } : {}),
  });
}

describe("Direct-API coding harness registration", () => {
  it("a session with a project exposes the registered coding tools", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const names = tools.list().map((t) => t.name);
    for (const name of CODING_TOOL_NAMES) expect(names).toContain(name);
    // memory/session surface still present alongside the harness
    expect(names).toContain("memory_search");
    expect(names).toContain("session_state");
  });

  it("advertised tool list matches the dispatcher exactly", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const advertised = tools.list().map((t) => t.name);
    // The wire schema advertised to the provider names exactly the registered surface.
    const wire = toOpenAiTools(tools.list()).map((t) => (t.function as { name: string }).name);
    expect([...wire].sort()).toEqual([...advertised].sort());
    // Every advertised tool dispatches without throwing (invalid args → clean error result).
    for (const name of advertised) {
      await expect(tools.call(name, {})).resolves.toBeDefined();
    }
    // A tool outside the advertised surface fails cleanly with the known list.
    await expect(tools.call("not_a_tool", {})).rejects.toThrow(UnknownToolError);
  });

  it("without a project path the session is chat-only (no coding tools registered or advertised)", async () => {
    const tools = await registry();
    const names = tools.list().map((t) => t.name);
    for (const name of CODING_TOOL_NAMES) expect(names).not.toContain(name);
    await expect(tools.call("exec", { command: "echo hi" })).rejects.toThrow(/Unknown tool "exec"/);
  });

  it("buildCodingTools registration is stable and non-empty", () => {
    const { dir } = tmpProject();
    const tools = buildCodingTools(dir);
    expect(tools.map((t) => t.definition.name)).toEqual([...CODING_TOOL_NAMES]);
    expect(codingToolsAvailable(dir)).toBe(true);
    expect(codingToolsAvailable("  ")).toBe(false);
    expect(codingToolsAvailable(undefined)).toBe(false);
  });
});

describe("exec through the local harness", () => {
  it("runs a shell command inside the project workspace", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const result = await tools.call("exec", { command: "echo hello-from-harness" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("hello-from-harness");
    expect(text).toContain("exit: 0");
    expect(result.isError).toBeUndefined();
  });

  it("succeeds end-to-end through the agent loop", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const runner: ApiRunner = {
      call: async (messages: readonly unknown[]): Promise<AgentTurnResult> => {
        const sawTool = messages.some((m) => (m as { role?: string }).role === "tool");
        return sawTool
          ? { content: "done", toolCalls: [], finishReason: "stop" }
          : { content: null, toolCalls: [{ id: "c1", name: "exec", arguments: JSON.stringify({ command: "printf hi-loop" }) }], finishReason: "tool_calls" };
      },
    };
    const events: string[] = [];
    const result = await runAgentLoop([{ role: "user", content: "go" }], { runner, tools, onEvent: (_e, d) => events.push(d) });
    expect(events.some((e) => e.includes("hi-loop"))).toBe(true);
    expect(events.some((e) => e.includes("Unknown tool"))).toBe(false);
    expect(result.finalContent).toBe("done");
    expect(result.toolCalls).toBe(1);
  });

  it("rejects a cwd outside the project workspace", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const result = await tools.call("exec", { command: "pwd", cwd: "/etc" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(result.isError).toBe(true);
    expect(text).toContain("escapes the project");
  });

  it("surfaces a failing command as a clean error result", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const result = await tools.call("exec", { command: "exit 3" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(result.isError).toBe(true);
    expect(text).toContain("exit: 3");
  });
});

describe("file tools and project-path isolation", () => {
  it("read_file reads inside the project", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const result = await tools.call("read_file", { path: "src/main.ts" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("export function main");
  });

  it("read_file rejects lexical escapes outside the project", async () => {
    const { dir, outside } = tmpProject();
    const tools = await registry(dir);
    const result = await tools.call("read_file", { path: "../outside.txt" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(result.isError).toBe(true);
    expect(text).toContain("escapes the project");
    // the outside file was never exposed
    expect(text).not.toContain("secret outside content");
    void outside;
  });

  it.runIf(symlinksSupported())("read_file rejects symlink escapes outside the project", async () => {
    const { dir, outside } = tmpProject();
    symlinkSync(outside, join(dir, "link.txt"));
    const tools = await registry(dir);
    const result = await tools.call("read_file", { path: "link.txt" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(result.isError).toBe(true);
    expect(text).toContain("symlink escape");
    expect(text).not.toContain("secret outside content");
  });

  it("write_file and edit_file operate inside the project; writes outside are rejected", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const written = await tools.call("write_file", { path: "src/new.txt", content: "hello\n" });
    expect(written.isError).toBeUndefined();
    const read = await tools.call("read_file", { path: "src/new.txt" });
    expect(read.content.map((c) => c.text).join("\n")).toContain("hello");
    const edited = await tools.call("edit_file", { path: "src/new.txt", find: "hello", replace: "hola" });
    expect(edited.isError).toBeUndefined();
    const reread = await tools.call("read_file", { path: "src/new.txt" });
    expect(reread.content.map((c) => c.text).join("\n")).toContain("hola");
    const escaped = await tools.call("write_file", { path: "../../evil.txt", content: "x" });
    expect(escaped.isError).toBe(true);
    expect(escaped.content.map((c) => c.text).join("\n")).toContain("escapes the project");
  });

  it("edit_file with a missing snippet fails cleanly", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const result = await tools.call("edit_file", { path: "src/main.ts", find: "nope-not-here", replace: "x" });
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text).join("\n")).toContain("not found");
  });

  it("list_files returns bounded project-relative paths", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const result = await tools.call("list_files", { depth: 3 });
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("src/");
    expect(text).toContain("src/main.ts");
    expect(text).toContain("README.md");
  });

  it("search_files finds matches and rejects an outside base path", async () => {
    const { dir } = tmpProject();
    const tools = await registry(dir);
    const found = await tools.call("search_files", { pattern: "main" });
    const foundText = found.content.map((c) => c.text).join("\n");
    expect(foundText).toContain("src/main.ts:1");
    const escaped = await tools.call("search_files", { pattern: "main", path: "../" });
    expect(escaped.isError).toBe(true);
    expect(escaped.content.map((c) => c.text).join("\n")).toContain("escapes the project");
  });
});

describe("unknown tools fail cleanly", () => {
  it("unregistered tools surface as a failure through the agent loop (no invented result)", async () => {
    const tools = await registry(); // chat-only: no coding harness
    const runner: ApiRunner = {
      call: async (messages: readonly unknown[]): Promise<AgentTurnResult> => {
        const sawTool = messages.some((m) => (m as { role?: string }).role === "tool");
        return sawTool
          ? { content: "ok", toolCalls: [], finishReason: "stop" }
          : { content: null, toolCalls: [{ id: "c1", name: "exec", arguments: "{}" }], finishReason: "tool_calls" };
      },
    };
    const events: string[] = [];
    const result = await runAgentLoop([{ role: "user", content: "go" }], { runner, tools, onEvent: (_e, d) => events.push(d) });
    expect(events.some((e) => e.includes("[tool failure]") && e.includes("Unknown tool \"exec\""))).toBe(true);
    expect(result.finalContent).toBe("ok");
  });
});

describe("system-prompt capability surface", () => {
  it("chat-only block marks the session chat-only and never advertises shell/filesystem tools", () => {
    const block = buildToolSurfaceBlock(false, undefined);
    expect(block.class).toBe("static-tools");
    expect(block.content).toContain("chat-only");
    // It must not name or present any coding tool as an available ability.
    for (const name of CODING_TOOL_NAMES) expect(block.content).not.toContain(name);
    expect(block.content).not.toMatch(/use exec|use read_file/i);
  });

  it("coding block advertises exactly the registered harness", () => {
    const block = buildToolSurfaceBlock(true, "/proj/x");
    expect(block.content).toContain("coding harness enabled");
    for (const name of CODING_TOOL_NAMES) expect(block.content).toContain(name);
    expect(block.content).toContain("/proj/x");
    expect(block.content).not.toContain("chat-only");
  });

  it("textResult helper shapes error results consistently", () => {
    const err = textResult("boom", true);
    expect(err.isError).toBe(true);
    const ok = textResult("fine");
    expect(ok.isError).toBeUndefined();
  });
});
