/**
 * Live model-list discovery from the installed CLIs — so CONTINUUM exposes
 * exactly what the authenticated CLI currently supports instead of a hardcoded
 * (and drifting) list. Two verified, local, read-only mechanisms, dispatched on
 * the profile's declared `modelDiscovery` data (never on provider id):
 *
 *   - cli-command — a real subcommand prints the list (agy `models`, verified:
 *     `<id>\t<label>` per line, already authenticated, no key read).
 *   - json-cache  — a JSON cache file the CLI itself maintains
 *     (~/.codex/models_cache.json, filtered to `visibility != "hide"`).
 *
 * Best-effort by contract: any I/O failure yields `[]` (or throws, per the
 * caller's catch) and the caller degrades to the manifest models. Discovery
 * never reads a credential and never mutates the CLI's state.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderProfile } from "./types.js";

export interface DiscoveredModel {
  readonly id: string;
  readonly label: string;
}

export interface ModelDiscoveryOptions {
  /** Injectable `execFile`-shaped runner for tests; defaults to node's. */
  readonly execFile?: (cmd: string, args: readonly string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
  readonly timeoutMs?: number;
}

const execFileAsync = promisify(execFile);

async function defaultExec(cmd: string, args: readonly string[], opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: opts?.timeout });
  return { stdout, stderr };
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Parse tab-separated `<id>\t<label>` CLI output (agy `models`). Tolerant:
 * header/blank/noise lines without a tab are dropped, never mis-parsed as a
 * model id.
 */
export function parseCliModelsOutput(text: string): readonly DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [id, ...rest] = line.split("\t");
    if (!id || rest.length === 0) continue; // needs an id AND a label (tab)
    models.push({ id: id.trim(), label: rest.join("\t").trim() });
  }
  return models;
}

/**
 * Parse the Codex model cache JSON (the CLI's own `~/.codex/models_cache.json`).
 * Hidden entries (`visibility: "hide"`, e.g. auto-review) are excluded so the
 * list mirrors what the model picker actually offers.
 */
export function parseCodexModelsCache(raw: string): readonly DiscoveredModel[] {
  const parsed = JSON.parse(raw) as { models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }> };
  const models: DiscoveredModel[] = [];
  for (const m of parsed.models ?? []) {
    if (m.visibility === "hide") continue;
    if (typeof m.slug !== "string" || m.slug.length === 0) continue;
    models.push({ id: m.slug, label: typeof m.display_name === "string" ? m.display_name : m.slug });
  }
  return models;
}

/**
 * Discover the current model list for a provider, dispatching on its declared
 * `modelDiscovery` data. Best-effort: a read/parse failure throws (the caller
 * degrades to manifest models); an empty declared list returns [].
 */
export async function discoverModelsFor(profile: ProviderProfile, opts: ModelDiscoveryOptions = {}): Promise<readonly DiscoveredModel[]> {
  const d = profile.modelDiscovery;
  if (!d) return [];
  const run = opts.execFile ?? defaultExec;
  // Bounded: `agy models` can stall indefinitely without a TTY (verified), so
  // discovery must never add more than ~4s of launch latency. The codex
  // json-cache path is a plain file read (no timeout risk).
  const timeoutMs = opts.timeoutMs ?? 4000;

  if (d.kind === "cli-command") {
    const { stdout, stderr } = await run(profile.cliLaunch.executable, d.command, { timeout: timeoutMs });
    return parseCliModelsOutput(`${stdout}\n${stderr}`);
  }

  const raw = await readFile(expandHome(d.path), "utf8");
  return parseCodexModelsCache(raw);
}
