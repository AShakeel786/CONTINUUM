// Repo Intelligence Map benchmark — measures map tokens + build latency for
// representative tasks against CONTINUUM itself. Run: node scripts/repo-map-benchmark.mjs
import { buildRepoMap, FileRepoMapCache } from "../dist/repo-map/repo-map.js";
import { estimateTokens } from "../dist/token/tokenizer.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = new FileRepoMapCache(mkdtempSync(join(tmpdir(), "repo-map-bench-")));

const tasks = [
  ["locate-auth-provider", "credential provider auth"],
  ["trace-launch-session-handoff", "launcher session handoff"],
  ["find-mcp-memory", "mcp memory tool"],
  ["known-bug-health-recovery", "health recovery doctor repair"],
];

console.log("Repo Intelligence Map benchmark (against CONTINUUM)");
console.log("====================================================");
let totalTokens = 0;
for (const [name, query] of tasks) {
  const t0 = performance.now();
  const cold = await buildRepoMap(root, query, { budgetTokens: 1200 }, cache);
  const coldMs = (performance.now() - t0).toFixed(0);

  const t1 = performance.now();
  const warm = await buildRepoMap(root, query, { budgetTokens: 1200 }, cache);
  const warmMs = (performance.now() - t1).toFixed(0);

  const tokens = cold.text ? estimateTokens(cold.text).tokens : 0;
  totalTokens += tokens;
  console.log(`${name.padEnd(28)} map=${String(tokens).padStart(4)} tok  files=${cold.fileCount}  symbols=${cold.symbolCount}  cold=${coldMs}ms warm=${warmMs}ms`);
}
console.log("---------------------------------------------------");
console.log(`avg map tokens: ${(totalTokens / tasks.length).toFixed(0)}`);
