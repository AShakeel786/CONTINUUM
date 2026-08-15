/**
 * Read-only git fingerprinting. Every command here is a read (`rev-parse`,
 * `branch --show-current`, `status --porcelain`, `remote get-url`) — this
 * module never resets, stashes, checks out, or otherwise mutates a
 * project's git state, per the Phase 5 brief ("Do not automatically
 * reset/stash/checkout").
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitFingerprint } from "./types.js";

const execFileAsync = promisify(execFile);

async function tryGit(args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args as string[], { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Captures a fingerprint of the given directory's git state. Fields that
 * can't be determined (not a git repo, no remote configured, git not on
 * PATH) are simply omitted — a partial fingerprint is still useful for
 * comparison (matches `Get-ProjectFingerprint`'s own "partial is ok, safety
 * check treats missing fields as can't-compare" stance).
 */
export async function captureGitFingerprint(cwd: string): Promise<GitFingerprint> {
  const repoRoot = (await tryGit(["rev-parse", "--show-toplevel"], cwd)) ?? cwd;
  const remote = await tryGit(["remote", "get-url", "origin"], cwd);
  const branch = await tryGit(["branch", "--show-current"], cwd);
  const headSha = await tryGit(["rev-parse", "HEAD"], cwd);
  const statusOutput = await tryGit(["status", "--porcelain"], cwd);

  const dirty = !!statusOutput && statusOutput.length > 0;
  const changedFileSummary = summarizeStatus(statusOutput);

  return {
    repoRoot,
    remote,
    branch,
    headSha,
    dirty,
    changedFileSummary,
    capturedAt: new Date().toISOString(),
  };
}

function summarizeStatus(statusOutput: string | undefined): string {
  if (!statusOutput) return "clean";
  const lines = statusOutput.split("\n").filter((l) => l.trim().length > 0);
  let modified = 0;
  let untracked = 0;
  let staged = 0;
  let other = 0;
  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code === "??") untracked++;
    else if (code.startsWith("M") || code.endsWith("M")) modified++;
    else if (code.startsWith("A") || code.startsWith("D") || code.startsWith("R")) staged++;
    else other++;
  }
  const parts: string[] = [];
  if (modified) parts.push(`${modified} modified`);
  if (staged) parts.push(`${staged} staged`);
  if (untracked) parts.push(`${untracked} untracked`);
  if (other) parts.push(`${other} other`);
  return parts.length > 0 ? parts.join(", ") : "clean";
}

export interface FingerprintComparison {
  readonly stale: boolean;
  readonly reasons: readonly string[];
}

/**
 * Compares a stored fingerprint (from when session state was last updated)
 * against a freshly-captured one. Only compares fields present on *both*
 * sides — a field missing from either is not evidence of drift, just
 * unknown (same "partial is ok" stance as capture itself).
 */
export function compareGitFingerprints(stored: GitFingerprint, current: GitFingerprint): FingerprintComparison {
  const reasons: string[] = [];

  if (stored.repoRoot && current.repoRoot && stored.repoRoot !== current.repoRoot) {
    reasons.push(`repo root changed (was "${stored.repoRoot}", now "${current.repoRoot}")`);
  }
  if (stored.branch && current.branch && stored.branch !== current.branch) {
    reasons.push(`branch changed (was "${stored.branch}", now "${current.branch}")`);
  }
  if (stored.headSha && current.headSha && stored.headSha !== current.headSha) {
    reasons.push(`HEAD changed (was ${stored.headSha.slice(0, 12)}, now ${current.headSha.slice(0, 12)}) -- unexpected commits since state was last recorded`);
  }
  if (stored.remote && current.remote && stored.remote !== current.remote) {
    reasons.push(`git remote changed (was "${stored.remote}", now "${current.remote}")`);
  }
  // Dirty-state alone (clean -> dirty or vice versa) is expected during
  // normal work and NOT flagged as staleness on its own -- only combined
  // with a HEAD/branch change, which suggests independent work happened
  // rather than the same agent continuing to edit.
  if (stored.dirty !== current.dirty && (reasons.length > 0)) {
    reasons.push(`working-tree cleanliness changed (was ${stored.dirty ? "dirty" : "clean"}, now ${current.dirty ? "dirty" : "clean"})`);
  }

  return { stale: reasons.length > 0, reasons };
}
