import { describe, expect, it } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureGitFingerprint, compareGitFingerprints } from "../git-fingerprint.js";

describe("captureGitFingerprint", () => {
  it("captures a real fingerprint of this repo (live, not mocked)", async () => {
    const fp = await captureGitFingerprint(process.cwd());
    expect(fp.repoRoot).toBeTruthy();
    expect(fp.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof fp.dirty).toBe("boolean");
    expect(fp.capturedAt).toBeTruthy();
  });

  it("returns a partial fingerprint (no throw) for a non-git directory", async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "continuum-not-a-repo-"));
    try {
      const fp = await captureGitFingerprint(dir);
      expect(fp.headSha).toBeUndefined();
      expect(fp.branch).toBeUndefined();
      expect(fp.dirty).toBe(false);
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("compareGitFingerprints — staleness detection", () => {
  const base = {
    repoRoot: "/repo",
    remote: "https://example.com/repo.git",
    branch: "main",
    headSha: "a".repeat(40),
    dirty: false,
    changedFileSummary: "clean",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };

  it("reports not stale when nothing changed", () => {
    const result = compareGitFingerprints(base, { ...base, capturedAt: "2026-01-02T00:00:00.000Z" });
    expect(result.stale).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("flags a HEAD change (unexpected commits) as stale", () => {
    const result = compareGitFingerprints(base, { ...base, headSha: "b".repeat(40) });
    expect(result.stale).toBe(true);
    expect(result.reasons.some((r) => r.includes("HEAD changed"))).toBe(true);
  });

  it("flags a branch change as stale", () => {
    const result = compareGitFingerprints(base, { ...base, branch: "feature/other" });
    expect(result.stale).toBe(true);
    expect(result.reasons.some((r) => r.includes("branch changed"))).toBe(true);
  });

  it("flags a remote change as stale", () => {
    const result = compareGitFingerprints(base, { ...base, remote: "https://example.com/different.git" });
    expect(result.stale).toBe(true);
  });

  it("does NOT flag dirty-state alone (clean -> dirty) as stale on its own -- that's expected during normal work", () => {
    const result = compareGitFingerprints(base, { ...base, dirty: true, changedFileSummary: "1 modified" });
    expect(result.stale).toBe(false);
  });

  it("ignores fields missing from either side rather than treating them as changed", () => {
    const partial = { ...base, remote: undefined };
    const result = compareGitFingerprints(partial, { ...base, remote: "https://example.com/repo.git" });
    expect(result.stale).toBe(false);
  });
});
