// Tool Output Optimizer benchmark — measures baseline vs optimized tokens over
// a representative corpus. Run: node scripts/tool-output-benchmark.mjs (after build).
import { optimizeToolOutput, telemetryLine } from "../dist/tool-output/optimizer.js";
import { FileRawOutputStore } from "../dist/tool-output/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = new FileRawOutputStore(mkdtempSync(join(tmpdir(), "bench-")));

function largeTestOutput() {
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`PASS src/module-${i}.test.ts (12ms)`);
  lines.push("FAIL src/critical.test.ts");
  lines.push("  Expected: 42");
  lines.push("  Received: 0");
  lines.push("      at Object.<anonymous> (/src/critical.test.ts:33:9)");
  lines.push("Tests: 151 passed, 1 failed, 152 total");
  return lines.join("\n");
}

function gitDiff() {
  const lines = ["diff --git a/src/a.ts b/src/a.ts", "index 111..222 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,5 +1,6 @@"];
  for (let i = 0; i < 80; i++) lines.push(`+  const x${i} = ${i};`);
  lines.push(" 3 files changed, 82 insertions(+), 4 deletions(-)");
  return lines.join("\n");
}

function gitStatus() {
  return "On branch main\nYour branch is up to date with 'origin/main'.\nChanges not staged for commit:\n" + Array.from({ length: 60 }, (_, i) => `  modified:   src/file${i}.ts`).join("\n") + "\nUntracked files:\n" + Array.from({ length: 10 }, (_, i) => `  new${i}.ts`).join("\n");
}

function gitLog() {
  return Array.from({ length: 40 }, (_, i) => `commit ${"abcdef0123456789".slice(0, 16)}\nAuthor: Dev <dev@example.com>\nDate:   Mon Jan ${i + 1} 00:00:00 2024 -0000\n\n    Commit message number ${i}\n`).join("\n");
}

function compilerOutput() {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(`Compiling module-${i}.ts`);
  lines.push("src/errors.ts:12:3: error TS2322: Type 'string' is not assignable to type 'number'.");
  lines.push("src/warn.ts:5:1: warning TS6133: 'unused' is declared but its value is never read.");
  lines.push("Found 1 error and 1 warning.");
  return lines.join("\n");
}

function jsonOutput() {
  return JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, active: i % 2 === 0, tags: ["a", "b", "c"] })) }, null, 2);
}

function appLogs() {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO processing request #${i % 5}`);
  lines.push("2024-01-01T00:00:00Z ERROR connection reset");
  return lines.join("\n");
}

function dirListing() {
  return "total 400\n" + Array.from({ length: 80 }, (_, i) => `drwxr-xr-x  2 user staff  4096 Jan ${i + 1} 00:00 dir-${i}`).join("\n") + "\n" + Array.from({ length: 80 }, (_, i) => `-rw-r--r--  1 user staff  1024 Jan ${i + 1} 00:00 file-${i}.ts`).join("\n");
}

const corpus = [
  ["large-test-output", largeTestOutput()],
  ["git-diff", gitDiff()],
  ["git-status", gitStatus()],
  ["git-log", gitLog()],
  ["compiler-output", compilerOutput()],
  ["json", jsonOutput()],
  ["app-logs", appLogs()],
  ["dir-listing", dirListing()],
];

let totalOriginal = 0;
let totalOptimized = 0;
console.log("Tool Output Optimizer benchmark");
console.log("======================================================");
for (const [name, text] of corpus) {
  const r = optimizeToolOutput(name, text, undefined, store);
  totalOriginal += r.telemetry.originalTokens;
  totalOptimized += r.telemetry.optimizedTokens;
  console.log(`${name.padEnd(20)} ${telemetryLine(r.telemetry)}`);
}
console.log("------------------------------------------------------");
console.log(`TOTAL: ${totalOriginal} → ${totalOptimized} tokens (${totalOriginal > 0 ? ((totalOriginal - totalOptimized) / totalOriginal * 100).toFixed(1) : 0}% reduction)`);
