/**
 * Local coding tools for Direct-API sessions — the in-process harness that
 * turns an API provider into a real coding agent inside the selected project.
 * Capability-gated: registered only when a project path is supplied. The
 * advertised tool list is always exactly the registered surface (the agent
 * loop sends `registry.list()` to the model and dispatches through the same
 * registry), so a tool like `exec` can never be implied without being real.
 *
 * Isolation: every file tool resolves its target inside the project root
 * (lexical check + realpath walk so symlinks cannot escape); `exec` runs with
 * the project as its working directory, rejects a `cwd` outside the project,
 * and never receives the launch plan's resolved provider secrets. Shell itself
 * is not a sandbox — this is the documented boundary CONTINUUM enforces.
 *
 * Caching: these tools are deliberately NOT cache-eligible. Their results
 * depend on mutable filesystem state, so a project-scoped cache could serve a
 * stale `read_file` right after a `write_file` in the same dirty session.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ContextBlock } from "../context/types.js";
import { textResult, type RegisteredTool } from "./tools.js";

export const CODING_TOOL_NAMES = ["exec", "read_file", "write_file", "edit_file", "list_files", "search_files"] as const;

/** A project-scoped coding harness is available iff a non-empty project path is supplied. */
export function codingToolsAvailable(projectPath: string | undefined): boolean {
  return typeof projectPath === "string" && projectPath.trim().length > 0;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "target", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".continuum"]);

const MAX_EXEC_OUTPUT_CHARS = 128_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_EXEC_TIMEOUT_MS = 120_000;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_READ_CHARS = 200_000;
const MAX_READ_LINES = 5_000;
const MAX_LIST_ENTRIES = 400;
const MAX_LIST_DEPTH = 8;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 2_000;

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a caller-supplied path to an absolute path inside `root`, rejecting
 * escapes. For a non-existent leaf (a write target), the deepest existing
 * ancestor's realpath is checked instead, so a symlinked directory cannot
 * smuggle a write outside the project.
 */
async function resolveInside(root: string, target: string | undefined): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (target === undefined || !target.trim()) return { ok: false, reason: 'a "path" inside the project is required' };
  const resolved = resolve(root, target);
  if (!isWithin(root, resolved)) return { ok: false, reason: `path escapes the project workspace (${resolved})` };
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = root;
  }
  let node = resolved;
  while (true) {
    try {
      const real = await fs.realpath(node);
      return isWithin(realRoot, real) ? { ok: true, path: resolved } : { ok: false, reason: `path resolves outside the project workspace (symlink escape)` };
    } catch {
      const parent = dirname(node);
      if (parent === node) return { ok: false, reason: `path does not exist within the project` };
      node = parent;
    }
  }
}

function relOf(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel === "" ? "." : rel;
}

/** Resolve an optional base path, defaulting to the project root when absent. */
async function resolveBase(root: string, pathArg: string | undefined): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (pathArg === undefined) return { ok: true, path: root };
  return resolveInside(root, pathArg);
}

// ── shell execution (bounded) ───────────────────────────────────────────

interface ShellRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: string;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellRun> {
  return new Promise((settle) => {
    let done = false;
    const finish = (r: ShellRun) => {
      if (!done) {
        done = true;
        settle(r);
      }
    };
    let child;
    try {
      child = spawn(command, { cwd, shell: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const cap = (buf: string, acc: string): string => (acc.length >= MAX_EXEC_OUTPUT_CHARS ? acc : acc + buf.slice(0, MAX_EXEC_OUTPUT_CHARS - acc.length));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = cap(String(chunk), stdout);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = cap(String(chunk), stderr);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

// ── bounded project walk (shared by list/search) ────────────────────────

async function walkFiles(
  base: string,
  root: string,
  opts: { maxDepth: number; maxEntries: number; maxFiles?: number },
): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  let scanned = 0;
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;

  async function visit(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > opts.maxDepth || files.length >= opts.maxEntries) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((e) => e.name).sort();
    for (const name of names) {
      if (files.length >= opts.maxEntries) return;
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let isDir = false;
      try {
        isDir = (await fs.stat(full)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        dirs.push(rel + "/");
        await visit(full, rel, depth + 1);
      } else {
        if (scanned >= maxFiles) continue;
        scanned += 1;
        files.push(rel);
      }
    }
  }

  await visit(base, relOf(root, base) === "." ? "" : relOf(root, base), 0);
  return { files, dirs };
}

// ── tool definitions ────────────────────────────────────────────────────

export function buildCodingTools(projectPath: string): RegisteredTool[] {
  const root = resolve(projectPath);
  const coding: RegisteredTool[] = [
    {
      definition: {
        name: "exec",
        description:
          "Run a shell command inside the selected project workspace. Returns the exit code plus capped stdout/stderr. The command runs with the project as its working directory (an optional project-relative `cwd` is honored); pointing the command elsewhere is rejected. Timeouts and output are bounded.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run, with the project as the working directory." },
            cwd: { type: "string", description: "Optional project-relative working directory (default: project root)." },
            timeoutMs: { type: "integer", minimum: 1000, maximum: MAX_EXEC_TIMEOUT_MS, description: `Bounded timeout (default ${DEFAULT_EXEC_TIMEOUT_MS / 1000}s, max ${MAX_EXEC_TIMEOUT_MS / 1000}s).` },
          },
          required: ["command"],
          additionalProperties: false,
        },
        access: "write",
      },
      handler: async (args) => {
        const command = typeof args.command === "string" ? args.command : "";
        if (!command.trim()) return textResult('exec requires a "command".', true);
        const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(Math.max(Math.round(args.timeoutMs), 1000), MAX_EXEC_TIMEOUT_MS) : DEFAULT_EXEC_TIMEOUT_MS;
        let cwd = root;
        if (args.cwd !== undefined) {
          const r = await resolveInside(root, typeof args.cwd === "string" ? args.cwd : undefined);
          if (!r.ok) return textResult(`exec: ${r.reason}`, true);
          cwd = r.path;
        }
        const run = await runShell(command, cwd, timeoutMs);
        if (run.spawnError) return textResult(`exec failed to start: ${run.spawnError}`, true);
        const parts: string[] = [`exit: ${run.code ?? "killed"}${run.timedOut ? " (timed out)" : ""}`];
        if (run.stdout) parts.push(`stdout:\n${run.stdout}${run.stdout.length >= MAX_EXEC_OUTPUT_CHARS ? "\n[stdout truncated]" : ""}`);
        if (run.stderr) parts.push(`stderr:\n${run.stderr}${run.stderr.length >= MAX_EXEC_OUTPUT_CHARS ? "\n[stderr truncated]" : ""}`);
        return textResult(parts.join("\n"), run.code !== 0 || run.timedOut);
      },
    },
    {
      definition: {
        name: "read_file",
        description:
          "Read a file inside the selected project. Returns the file content, optionally restricted to a line range. Output is bounded to keep responses token-light.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Project-relative (or absolute, within the project) path to read." },
            startLine: { type: "integer", minimum: 1, description: "1-based first line to return (default 1)." },
            maxLines: { type: "integer", minimum: 1, maximum: MAX_READ_LINES, description: `Max lines to return (default ${MAX_READ_LINES}).` },
            maxChars: { type: "integer", minimum: 100, maximum: MAX_READ_CHARS, description: `Cap on returned characters (default ${MAX_READ_CHARS}).` },
          },
          required: ["path"],
          additionalProperties: false,
        },
        access: "read",
      },
      handler: async (args) => {
        const r = await resolveInside(root, typeof args.path === "string" ? args.path : undefined);
        if (!r.ok) return textResult(`read_file: ${r.reason}`, true);
        let text: string;
        try {
          text = await fs.readFile(r.path, "utf8");
        } catch (err) {
          return textResult(`read_file: ${err instanceof Error ? err.message : String(err)}`, true);
        }
        const startLine = typeof args.startLine === "number" ? Math.max(1, Math.round(args.startLine)) : 1;
        const maxLines = typeof args.maxLines === "number" ? Math.min(Math.max(1, Math.round(args.maxLines)), MAX_READ_LINES) : MAX_READ_LINES;
        const maxChars = typeof args.maxChars === "number" ? Math.min(Math.max(100, Math.round(args.maxChars)), MAX_READ_CHARS) : MAX_READ_CHARS;
        let lines = text.split("\n");
        if (startLine > 1) lines = lines.slice(startLine - 1);
        const truncatedLines = lines.length > maxLines;
        if (truncatedLines) lines = lines.slice(0, maxLines);
        let out = lines.join("\n");
        const truncatedChars = out.length > maxChars;
        if (truncatedChars) out = out.slice(0, maxChars);
        const notes: string[] = [];
        if (truncatedLines) notes.push(`[output truncated to ${maxLines} lines]`);
        if (truncatedChars) notes.push(`[output truncated to ${maxChars} chars]`);
        return textResult(notes.length ? `${out}\n${notes.join("\n")}` : out);
      },
    },
    {
      definition: {
        name: "write_file",
        description:
          "Create or overwrite a file inside the selected project (parent directories are created as needed). Writing outside the project is rejected. Write-only.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Project-relative (or absolute, within the project) path to write." },
            content: { type: "string", description: "Full file content to write." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        access: "write",
      },
      handler: async (args) => {
        const r = await resolveInside(root, typeof args.path === "string" ? args.path : undefined);
        if (!r.ok) return textResult(`write_file: ${r.reason}`, true);
        const content = typeof args.content === "string" ? args.content : "";
        if (content.length > MAX_WRITE_CHARS) return textResult(`write_file: content too large (max ${MAX_WRITE_CHARS} chars)`, true);
        try {
          await fs.mkdir(dirname(r.path), { recursive: true });
          await fs.writeFile(r.path, content, "utf8");
          return textResult(`wrote ${relOf(root, r.path)} (${Buffer.byteLength(content, "utf8")} bytes)`);
        } catch (err) {
          return textResult(`write_file: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    },
    {
      definition: {
        name: "edit_file",
        description:
          "Replace every occurrence of a literal snippet in a file inside the selected project. Fails cleanly if the snippet is not found. Write-only.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Project-relative (or absolute, within the project) path to edit." },
            find: { type: "string", description: "Literal text to replace (all occurrences)." },
            replace: { type: "string", description: "Replacement text." },
          },
          required: ["path", "find", "replace"],
          additionalProperties: false,
        },
        access: "write",
      },
      handler: async (args) => {
        const r = await resolveInside(root, typeof args.path === "string" ? args.path : undefined);
        if (!r.ok) return textResult(`edit_file: ${r.reason}`, true);
        const find = typeof args.find === "string" ? args.find : "";
        const replace = typeof args.replace === "string" ? args.replace : "";
        if (!find) return textResult('edit_file requires a non-empty "find".', true);
        let text: string;
        try {
          text = await fs.readFile(r.path, "utf8");
        } catch (err) {
          return textResult(`edit_file: ${err instanceof Error ? err.message : String(err)}`, true);
        }
        if (!text.includes(find)) return textResult("edit_file: find snippet not found in file", true);
        const count = text.split(find).length - 1;
        const updated = text.split(find).join(replace);
        if (updated.length > MAX_WRITE_CHARS) return textResult(`edit_file: result too large (max ${MAX_WRITE_CHARS} chars)`, true);
        try {
          await fs.writeFile(r.path, updated, "utf8");
          return textResult(`replaced ${count} occurrence(s) in ${relOf(root, r.path)}`);
        } catch (err) {
          return textResult(`edit_file: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    },
    {
      definition: {
        name: "list_files",
        description:
          "List files and directories inside the selected project (bounded depth, heavy/vendor directories skipped). Returns sorted project-relative paths; directories end with '/'. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional project-relative directory to list (default: project root)." },
            depth: { type: "integer", minimum: 1, maximum: MAX_LIST_DEPTH, description: `Max nesting depth (default 3, max ${MAX_LIST_DEPTH}).` },
            maxEntries: { type: "integer", minimum: 1, maximum: MAX_LIST_ENTRIES, description: `Max entries returned (default 200, max ${MAX_LIST_ENTRIES}).` },
          },
          additionalProperties: false,
        },
        access: "read",
      },
      handler: async (args) => {
        const base = await resolveBase(root, typeof args.path === "string" ? args.path : undefined);
        if (!base.ok) return textResult(`list_files: ${base.reason}`, true);
        const maxDepth = typeof args.depth === "number" ? Math.min(Math.max(1, Math.round(args.depth)), MAX_LIST_DEPTH) : 3;
        const maxEntries = typeof args.maxEntries === "number" ? Math.min(Math.max(1, Math.round(args.maxEntries)), MAX_LIST_ENTRIES) : 200;
        const { files, dirs } = await walkFiles(base.path, root, { maxDepth, maxEntries });
        const all = [...dirs, ...files].sort();
        if (all.length === 0) return textResult("(no files)");
        return textResult(all.join("\n"));
      },
    },
    {
      definition: {
        name: "search_files",
        description:
          "Search project files for a regex pattern. Returns matching lines as `path:line: text`, bounded. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for (case-insensitive unless `caseSensitive` is set)." },
            path: { type: "string", description: "Optional project-relative directory to search (default: project root)." },
            maxResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, description: `Max matches returned (default 50, max ${MAX_SEARCH_RESULTS}).` },
            caseSensitive: { type: "boolean", description: "Match case-sensitively (default false)." },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        access: "read",
      },
      handler: async (args) => {
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        if (!pattern) return textResult('search_files requires a "pattern".', true);
        let re: RegExp;
        try {
          re = new RegExp(pattern, args.caseSensitive === true ? "" : "i");
        } catch (err) {
          return textResult(`search_files: invalid regex: ${err instanceof Error ? err.message : String(err)}`, true);
        }
        const base = await resolveBase(root, typeof args.path === "string" ? args.path : undefined);
        if (!base.ok) return textResult(`search_files: ${base.reason}`, true);
        const maxResults = typeof args.maxResults === "number" ? Math.min(Math.max(1, Math.round(args.maxResults)), MAX_SEARCH_RESULTS) : 50;
        const { files } = await walkFiles(base.path, root, { maxDepth: MAX_LIST_DEPTH, maxEntries: MAX_SEARCH_FILES, maxFiles: MAX_SEARCH_FILES });
        const matches: string[] = [];
        for (const rel of files) {
          if (matches.length >= maxResults) break;
          let text: string;
          try {
            text = await fs.readFile(join(root, rel), "utf8");
          } catch {
            continue;
          }
          if (text.includes("\u0000")) continue; // binary
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
            if (re.test(lines[i]!)) {
              matches.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 200)}`);
            }
          }
        }
        return textResult(matches.length ? matches.join("\n") : "no matches");
      },
    },
  ];
  return coding;
}

// ── system-prompt capability surface (chat-only vs coding harness) ──────

/**
 * The `static-tools` system-prompt block that tells the model exactly what the
 * session can do. The chat-only variant explicitly names the absence of
 * shell/filesystem ability and never advertises tool names it cannot honor.
 */
export function buildToolSurfaceBlock(coding: boolean, projectPath?: string): ContextBlock {
  const content = coding
    ? `Tool surface: local coding harness enabled. Registered tools: ${CODING_TOOL_NAMES.join(", ")}. ` +
      `File and shell tools are scoped to the selected project directory (${projectPath ?? "workspace"}). ` +
      `Use exec for shell commands; read_file/write_file/edit_file to inspect and modify files; list_files/search_files to navigate the project.`
    : `Tool surface: chat-only. This direct-API session has no local coding harness: it cannot run shell commands or modify project files.`;
  return {
    id: "static-tools:capability",
    class: "static-tools",
    content,
    priority: 10,
    provenance: { source: "continuum:tool-surface", fetchedAt: new Date().toISOString() },
  };
}
