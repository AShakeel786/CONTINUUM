import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimizeToolOutput } from "../optimizer.js";
import { FileRawOutputStore } from "../store.js";
import {
  dedupeRepeatedLines,
  optimizeCompiler,
  optimizeGitLog,
  optimizeGitStatus,
  optimizeJson,
  optimizeTestRunner,
} from "../optimizers.js";

function store(): FileRawOutputStore {
  return new FileRawOutputStore(mkdtempSync(join(tmpdir(), "tool-output-")));
}

describe("optimizers — deterministic lossless-first", () => {
  it("minifies JSON (lossless)", () => {
    expect(optimizeJson('{\n  "a": 1,\n  "b": [2, 3]\n}')).toBe('{"a":1,"b":[2,3]}');
  });

  it("dedupes repeated identical lines (lossless, with count)", () => {
    expect(dedupeRepeatedLines("a\na\na\na\na\na\na\na\na\na\nb\nc\nc\nc\nc\n")).toBe("a  (×10)\nb\nc  (×4)");
  });

  it("test runner preserves FAIL + summary + assertion context, collapses PASS", () => {
    const out = [
      ...Array.from({ length: 20 }, (_, i) => `PASS src/mod-${i}.test.ts`),
      "FAIL src/c.test.ts",
      "  ● renders the widget",
      "  Expected: 1",
      "  Received: 2",
      "    at Object.<anonymous> (src/c.test.ts:42:5)",
      "Tests: 20 passed, 1 failed, 21 total",
    ].join("\n");
    const r = optimizeTestRunner(out)!;
    // Complete failure identity survives.
    expect(r).toContain("FAIL src/c.test.ts");
    expect(r).toContain("Expected: 1");
    expect(r).toContain("Received: 2");
    expect(r).toContain("src/c.test.ts:42:5");
    expect(r).toContain("1 failed");
    // Passing noise is gone, and the marker says the failure record is complete.
    expect(r).not.toContain("PASS src/mod-0.test.ts");
    expect(r).toContain("failures below are complete");
    expect(r.length).toBeLessThan(out.length);
  });

  it("compiler preserves file:line:col diagnostics and drops compile noise", () => {
    const out = [
      ...Array.from({ length: 30 }, (_, i) => `Compiling file-${i}.ts`),
      "src/a.ts:12:3: error TS2322: Type 'x' is not assignable to type 'y'.",
      "src/b.ts:5:1: warning TS6133: 'z' is declared but never used.",
      "Found 1 error and 1 warning.",
    ].join("\n");
    const r = optimizeCompiler(out)!;
    expect(r).toContain("src/a.ts:12:3: error");
    expect(r).toContain("src/b.ts:5:1: warning");
    expect(r).not.toContain("Compiling file-0.ts");
  });

  it("git status collapses to a file list (preserves all filenames)", () => {
    const out = "On branch main\nChanges not staged for commit:\n  modified:   src/a.ts\n  modified:   src/b.ts\nUntracked files:\n  src/c.ts\n  (use \"git add <file>...\" to include in what will be committed)\n";
    const r = optimizeGitStatus(out)!;
    expect(r).toContain("src/a.ts");
    expect(r).toContain("src/c.ts");
    expect(r).not.toContain("use \"git add");
    expect(r.length).toBeLessThan(out.length);
  });

  it("git log collapses to sha + subject", () => {
    const out = "commit abcdef1234567890\nAuthor: Me <me@x.com>\nDate:   Tue Jan 1 00:00:00 2024\n\n    Fix the thing\n\ncommit 1234567890abcdef\n    Add feature\n";
    const r = optimizeGitLog(out)!;
    expect(r).toContain("abcdef12 Fix the thing");
    expect(r).toContain("12345678 Add feature");
    expect(r).not.toContain("Author:");
  });
});

describe("optimizeToolOutput — dispatch + telemetry + raw retention", () => {
  it("optimizes a large git status and retains raw byte-for-byte", () => {
    const s = store();
    const big = "On branch main\nYour branch is up to date.\nChanges not staged for commit:\n" + Array.from({ length: 40 }, (_, i) => `  modified:   src/file${i}.ts`).join("\n");
    const r = optimizeToolOutput("git", big, undefined, s);
    expect(r.telemetry.optimizer).toBe("git-status");
    expect(r.telemetry.optimizedTokens).toBeLessThan(r.telemetry.originalTokens);
    expect(r.telemetry.rawRetained).toBe(true);
    expect(r.rawRef).toMatch(/^tool-output:\/\//);
    expect(s.get(r.rawRef!.replace("tool-output://", ""))).toBe(big);
  });

  it("passes through short / unsuitable output unchanged", () => {
    const r = optimizeToolOutput("memory_search", "short result", undefined, store());
    expect(r.telemetry.optimizer).toBe("passthrough");
    expect(r.telemetry.rawRetained).toBe(false);
    expect(r.text).toBe("short result");
    expect(r.rawRef).toBeUndefined();
  });

  it("never fabricates a successful result — errors stay verbatim", () => {
    const out = "FAIL critical.test.ts\n  Error: boom\n      at stack.ts:1:1\n" + Array.from({ length: 30 }, () => "PASS ok.test.ts").join("\n");
    const r = optimizeToolOutput("npm", out, undefined, store());
    expect(r.text).toContain("FAIL critical.test.ts");
    expect(r.text).toContain("Error: boom");
  });

  it("adversarial: buried error inside repetitive logs survives dedup", () => {
    const s = store();
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push("INFO: processing item " + i);
    lines.push("ERROR: connection reset");
    const r = optimizeToolOutput("app", lines.join("\n"), undefined, s);
    expect(r.text).toContain("ERROR: connection reset");
  });
});
