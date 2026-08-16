// Combined token-efficiency benchmark — measures all four mechanisms with ablations
// (baseline, +A, +A+B, +A+B+C, +A+B+C+D) on a simulated realistic task.
// Run: node scripts/token-efficiency-benchmark.mjs
import { allocateBudget } from "../dist/token/budget.js";
import { applyReversiblePruning, FilePruneStore } from "../dist/context/pruning.js";
import { buildRepoMap } from "../dist/repo-map/repo-map.js";
import { optimizeToolOutput } from "../dist/tool-output/optimizer.js";
import { ToolResultCache, computeCacheKey } from "../dist/tool-cache/tool-cache.js";
import { estimateTokens } from "../dist/token/tokenizer.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd } from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // CONTINUUM repo

// Deterministic tool-result payloads that a coding task would produce.
function toolResults() {
  return [
    ["project_list", "{}", "project", JSON.stringify([...Array(15)].map((_, i) => ({ name: `proj-${i}`, path: `/w/proj-${i}` })))],
    ["session_state", '{"sessionId":"s1"}', "session", JSON.stringify({ sessionId: "s1", status: "active", completedWork: ["a", "b", "c"] })],
    ["memory_search", '{"query":"auth"}', undefined, JSON.stringify({ items: [{ id: "m1", content: "recalled memory detail ".repeat(30) }] })],
    ["large_test", "{}", undefined, "PASS ".repeat(0) + Array.from({ length: 80 }, (_, i) => `PASS src/t${i}.test.ts`).join("\n") + "\nFAIL src/critical.test.ts\n  Expected 42 Received 0"],
  ];
}

function block(id, cls, content, priority = 50) {
  return { id, class: cls, content, priority, provenance: { source: "bench", fetchedAt: new Date().toISOString() } };
}

function buildEnvelope(query, withRepoMap, repoMapText) {
  const blocks = [
    block("instr", "instructions", "You are a coding agent. Constraints: never invent results.\n".repeat(4), 0),
    block("task", "current-task", query, 0),
  ];
  if (withRepoMap && repoMapText) blocks.push(block("repomap", "project-context", repoMapText, 20));
  // long-session history
  for (let i = 0; i < 20; i++) blocks.push(block(`conv-${i}`, "recent-conversation", `Turn ${i} text\n`.repeat(10), 60));
  for (let i = 0; i < 20; i++) blocks.push(block(`tool-${i}`, "tool-results", `tool result ${i}\n` + "  line\n".repeat(15), 70));
  for (let i = 0; i < 10; i++) blocks.push(block(`mem-${i}`, "recalled-memory", `memory ${i}\n` + "  detail\n".repeat(12), 90));
  const stable = blocks.filter((b) => ["instructions", "project-context", "persona", "scene-index", "static-tools"].includes(b.class));
  const dynamic = blocks.filter((b) => !stable.includes(b));
  return { stable: { blocks: stable }, dynamic: { blocks: dynamic }, metadata: { sessionKey: "s1", query, assembledAt: new Date().toISOString() } };
}

async function runConfig(query, flags) {
  // B: repo map
  let repoMapText = "";
  if (flags.repoMap) {
    const r = await buildRepoMap(root, query, { budgetTokens: 800 });
    repoMapText = r.text;
  }
  const envelope = buildEnvelope(query, flags.repoMap, repoMapText);
  const budget = allocateBudget(envelope, { contextWindow: 3000, reservedOutput: 512 });
  let pruned = 0, externalized = 0;
  let finalEnvelope = budget.envelope;
  if (flags.pruning) {
    const store = new FilePruneStore(mkdtempSync(join(tmpdir(), "final-")));
    const res = await applyReversiblePruning(envelope, budget, store, "s1");
    finalEnvelope = res.envelope;
    pruned = res.telemetry.blocksPruned;
    externalized = res.telemetry.tokensExternalized;
  }
  const envelopeTokens = [...finalEnvelope.stable.blocks, ...finalEnvelope.dynamic.blocks].reduce((s, b) => s + estimateTokens(b.content).tokens, 0);

  // A + C: tool-result pipeline
  const cache = new ToolResultCache();
  let rawToolTokens = 0, optToolTokens = 0, hits = 0, misses = 0, executions = 0;
  const tasks = toolResults();
  // run the tool sequence 4x to exercise the cache
  for (let round = 0; round < 4; round++) {
    for (const [name, argsJson, scopeName, payload] of tasks) {
      if (flags.cache && scopeName) {
        const fp = scopeName === "project" ? "fp-project" : scopeName === "session" ? "fp-session" : "global";
        const key = computeCacheKey(name, argsJson, scopeName, fp);
        if (key && cache.get(key) !== undefined) { hits++; optToolTokens += cache.tokensSavedForKey(key); continue; }
        misses++; executions++;
        const opt = flags.optimizer ? optimizeToolOutput(name, payload) : { text: payload, telemetry: { tokensSaved: 0 } };
        const finalText = opt.rawRef ? `${opt.text}\n[raw: ${opt.rawRef}]` : opt.text;
        if (key) cache.set(key, finalText, estimateTokens(finalText).tokens);
        rawToolTokens += estimateTokens(payload).tokens;
        optToolTokens += estimateTokens(finalText).tokens;
      } else {
        executions++;
        const opt = flags.optimizer ? optimizeToolOutput(name, payload) : { text: payload, telemetry: { tokensSaved: 0 } };
        const finalText = opt.rawRef ? `${opt.text}\n[raw: ${opt.rawRef}]` : opt.text;
        rawToolTokens += estimateTokens(payload).tokens;
        optToolTokens += estimateTokens(finalText).tokens;
      }
    }
  }
  const totalInput = envelopeTokens + optToolTokens;
  return { envelopeTokens, repoMapTokens: repoMapText ? estimateTokens(repoMapText).tokens : 0, rawToolTokens, optToolTokens, hits, misses, executions, pruned, externalized, totalInput };
}

const query = "locate the auth credential code and fix the failing test";
console.log("Combined token-efficiency benchmark (task: locate auth + fix failing test)");
console.log("==========================================================================");
const configs = [
  ["baseline", {}],
  ["A", { optimizer: true }],
  ["A+B", { optimizer: true, repoMap: true }],
  ["A+B+C", { optimizer: true, repoMap: true, cache: true }],
  ["A+B+C+D", { optimizer: true, repoMap: true, cache: true, pruning: true }],
];
let baseline;
for (const [label, flags] of configs) {
  const r = await runConfig(query, flags);
  if (label === "baseline") baseline = r;
  console.log(`${label.padEnd(8)} totalInput=${r.totalInput}  envelope=${r.envelopeTokens}  repoMap=${r.repoMapTokens}  toolRaw=${r.rawToolTokens}  toolOpt=${r.optToolTokens}  cacheHits=${r.hits}  exec=${r.executions}  pruned=${r.pruned}  ext=${r.externalized}`);
}
console.log("--------------------------------------------------------------------------");
console.log(`baseline total input: ${baseline.totalInput} tokens`);
