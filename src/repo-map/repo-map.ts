/**
 * Repo Intelligence Map — a token-budgeted, task-relevant codebase index.
 * Independently implemented (regex/ctags-style local parsing; no tree-sitter,
 * no upstream code). Provides *navigation context only* — it never replaces a
 * real file read, and degrades to "no map" if indexing is unavailable.
 *
 * Pipeline: scan → symbol extract → rank by query + structural importance →
 * render to a compact budgeted text → cache keyed by git/file fingerprint.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { estimateTokens } from "../token/tokenizer.js";
import type { ContextBlock } from "../context/types.js";

const execFileAsync = promisify(execFile);

export interface RepoSymbol {
  readonly name: string;
  readonly kind: string;
}

export interface RepoFileEntry {
  readonly path: string;
  readonly symbols: readonly RepoSymbol[];
  readonly imports: readonly string[];
}

export interface RepoIndex {
  readonly root: string;
  readonly files: readonly RepoFileEntry[];
  readonly fingerprint: string;
}

export interface RepoMapOptions {
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly budgetTokens?: number;
  readonly includeTests?: boolean;
}

export interface RepoMapResult {
  readonly text: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly fingerprint: string;
  readonly built: boolean;
}

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_BUDGET_TOKENS = 1200;
const MAX_SYMBOLS_PER_FILE = 60;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "target", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".continuum"]);

// ── symbol extraction (regex, per language) ────────────────────────────

function extractSymbols(path: string, text: string): { symbols: RepoSymbol[]; imports: string[] } {
  const symbols = new Map<string, string>();
  const imports: string[] = [];
  const add = (name: string, kind: string) => {
    if (!name || /^[0-9]/.test(name)) return;
    if (!symbols.has(name)) symbols.set(name, kind);
  };

  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
    // exports: export (default) (async) function|class|const|let|var|interface|type|enum NAME
    const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
    for (const m of text.matchAll(exportRe)) add(m[1]!, "export");
    // class / function declarations
    const classRe = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
    for (const m of text.matchAll(classRe)) add(m[1]!, "class");
    const funcRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
    for (const m of text.matchAll(funcRe)) add(m[1]!, "function");
    // interface / type / enum
    const typeRe = /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
    for (const m of text.matchAll(typeRe)) add(m[1]!, "type");
    // imports
    const importRe = /^import\s+.*?from\s+['"]([^'"]+)['"]/gm;
    for (const m of text.matchAll(importRe)) if (m[1]!.startsWith(".")) imports.push(m[1]!);
  } else if (/\.py$/.test(path)) {
    const classRe = /^class\s+([A-Za-z_]\w*)/gm;
    for (const m of text.matchAll(classRe)) add(m[1]!, "class");
    const funcRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm;
    for (const m of text.matchAll(funcRe)) add(m[1]!, "function");
    const importRe = /^(?:from|import)\s+([A-Za-z0-9_.]+)/gm;
    for (const m of text.matchAll(importRe)) imports.push(m[1]!);
  }

  const capped = [...symbols.entries()].slice(0, MAX_SYMBOLS_PER_FILE).map(([name, kind]) => ({ name, kind }));
  return { symbols: capped, imports: [...new Set(imports)].slice(0, 20) };
}

// ── scan (bounded, cross-platform) ─────────────────────────────────────

export async function scanProject(root: string, opts: RepoMapOptions): Promise<RepoIndex> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const includeTests = opts.includeTests ?? false;
  const files: RepoFileEntry[] = [];
  let newestMtime = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        if (rel.includes("/__tests__/") || /\.(test|spec)\./.test(rel)) {
          if (!includeTests) continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(rel)) continue;
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs > newestMtime) newestMtime = stat.mtimeMs;
          const text = await fs.readFile(full, "utf8");
          const { symbols, imports } = extractSymbols(rel, text);
          files.push({ path: rel, symbols, imports });
        } catch {
          // unreadable/binary → skip
        }
      }
    }
  }

  await walk(root, 0);

  const headSha = await tryGit(["rev-parse", "HEAD"], root) ?? "nogit";
  const dirty = (await tryGit(["status", "--porcelain"], root))?.length ? "dirty" : "clean";
  const fingerprint = `${headSha}:${dirty}:${Math.round(newestMtime)}`;

  return { root, files, fingerprint };
}

async function tryGit(args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args as string[], { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

// ── ranking ────────────────────────────────────────────────────────────

function scoreFile(entry: RepoFileEntry, queryTerms: readonly string[]): number {
  const path = entry.path.toLowerCase();
  let score = 0;
  // query relevance
  for (const term of queryTerms) {
    if (path.includes(term)) score += 6;
    for (const s of entry.symbols) if (s.name.toLowerCase().includes(term)) score += 3;
  }
  // structural importance
  if (/^(index|main|cli|server|app)\b/.test(entry.path.split("/").pop() ?? "")) score += 4;
  if (/^(src\/cli|src\/launcher|src\/auth|src\/session|src\/handoff|src\/providers|src\/context)\//.test(path)) score += 2;
  if (entry.symbols.some((s) => s.kind === "export")) score += 1;
  // prefer files with symbols over empty ones
  if (entry.symbols.length > 0) score += 1;
  return score;
}

// ── render (token-budgeted) ────────────────────────────────────────────

function renderMap(index: RepoIndex, query: string, budgetTokens: number): string {
  const queryTerms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2).slice(0, 12);
  const ranked = [...index.files]
    .map((f) => ({ f, score: scoreFile(f, queryTerms) }))
    .sort((a, b) => b.score - a.score || (a.f.path < b.f.path ? -1 : 1));

  const lines: string[] = [`repo-map (${index.files.length} files)`];
  let used = estimateTokens(lines.join("\n")).tokens;

  for (const { f } of ranked) {
    const symbolList = f.symbols.map((s) => `${s.name}(${s.kind})`).join(" ");
    const line = `${f.path}${symbolList ? `: ${symbolList}` : ""}`;
    const tokens = estimateTokens(line).tokens;
    if (used + tokens > budgetTokens) continue;
    lines.push(line);
    used += tokens;
  }

  return lines.join("\n");
}

// ── public build (with disk cache) ─────────────────────────────────────

export interface RepoMapCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, text: string): Promise<void>;
}

export async function buildRepoMap(root: string, query: string, opts: RepoMapOptions = {}, cache?: RepoMapCache): Promise<RepoMapResult> {
  const budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  let index: RepoIndex;
  try {
    index = await scanProject(root, opts);
  } catch {
    return { text: "", fileCount: 0, symbolCount: 0, fingerprint: "", built: false };
  }
  if (index.files.length === 0) {
    return { text: "", fileCount: 0, symbolCount: 0, fingerprint: index.fingerprint, built: false };
  }

  const cacheKey = `${root}:${index.fingerprint}`;
  const cached = await cache?.get(cacheKey).catch(() => undefined);
  let text: string;
  if (cached !== undefined) {
    text = cached;
  } else {
    text = renderMap(index, query, budgetTokens);
    await cache?.set(cacheKey, text).catch(() => {});
  }

  const symbolCount = index.files.reduce((n, f) => n + f.symbols.length, 0);
  return { text, fileCount: index.files.length, symbolCount, fingerprint: index.fingerprint, built: true };
}

/** A `project-context` ContextBlock to inject into ContextEnvelope. */
export function repoMapBlock(result: RepoMapResult, query: string): ContextBlock | undefined {
  if (!result.built || !result.text) return undefined;
  return {
    id: "repo-map",
    class: "project-context",
    content: result.text,
    priority: 20,
    provenance: { source: "repo-map", fetchedAt: new Date().toISOString() },
  };
}

// ── disk cache (survives process restarts, keyed by fingerprint) ───────

import { createHash } from "node:crypto";

export class FileRepoMapCache implements RepoMapCache {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private path(key: string): string {
    const h = createHash("sha1").update(key).digest("hex").slice(0, 32);
    return join(this.dir, `${h}.map`);
  }
  async get(key: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.path(key), "utf8");
    } catch {
      return undefined;
    }
  }
  async set(key: string, text: string): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.path(key), text, "utf8");
    } catch {
      // cache write failure is non-fatal
    }
  }
}
