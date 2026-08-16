// Reversible Context Pruning benchmark — active tokens vs externalized tokens for
// long-session envelopes. Run: node scripts/pruning-benchmark.mjs
import { allocateBudget } from "../dist/token/budget.js";
import { applyReversiblePruning, FilePruneStore } from "../dist/context/pruning.js";
import { estimateTokens } from "../dist/token/tokenizer.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function block(id, cls, content, priority = 50) {
  return { id, class: cls, content, priority, provenance: { source: "bench", fetchedAt: new Date().toISOString() } };
}
function envelope(blocks) {
  const stable = blocks.filter((b) => ["instructions", "project-context", "persona", "scene-index", "static-tools"].includes(b.class));
  const dynamic = blocks.filter((b) => !stable.includes(b));
  return { stable: { blocks: stable }, dynamic: { blocks: dynamic }, metadata: { sessionKey: "sess", query: "q", assembledAt: new Date().toISOString() } };
}

function longSession() {
  const blocks = [block("instr", "instructions", "You are a coding agent. Follow these constraints.\n".repeat(5), 0)];
  // old conversation turns (recent-conversation)
  for (let i = 0; i < 30; i++) blocks.push(block(`conv-${i}`, "recent-conversation", `Turn ${i}: user said something long.\n`.repeat(8), 60));
  // repeated tool results (tool-results)
  for (let i = 0; i < 30; i++) blocks.push(block(`tool-${i}`, "tool-results", `tool output ${i}:\n` + "  line of output\n".repeat(20), 70));
  // old recalled-memory
  for (let i = 0; i < 20; i++) blocks.push(block(`mem-${i}`, "recalled-memory", `recalled memory ${i}:\n` + "  context detail\n".repeat(15), 90));
  // old project-context
  for (let i = 0; i < 10; i++) blocks.push(block(`proj-${i}`, "project-context", `project context ${i}:\n` + "  module info\n".repeat(10), 80));
  return envelope(blocks);
}

const e = longSession();
const all = [...e.stable.blocks, ...e.dynamic.blocks];
const baselineTokens = all.reduce((s, b) => s + estimateTokens(b.content).tokens, 0);
console.log("Reversible Context Pruning benchmark (long session)");
console.log("==================================================");
console.log(`baseline active tokens (unpruned): ${baselineTokens}`);

const store = new FilePruneStore(mkdtempSync(join(tmpdir(), "prune-bench-")));
const budget = allocateBudget(e, { contextWindow: 4000, reservedOutput: 512 });
const result = await applyReversiblePruning(e, budget, store, "sess");
const active = [...result.envelope.stable.blocks, ...result.envelope.dynamic.blocks].reduce((s, b) => s + estimateTokens(b.content).tokens, 0);
console.log(`active tokens after pruning:       ${active}`);
console.log(`externalized tokens:               ${result.telemetry.tokensExternalized}`);
console.log(`blocks pruned:                     ${result.telemetry.blocksPruned}`);
console.log(`reduction:                         ${(((baselineTokens - active) / baselineTokens) * 100).toFixed(1)}%`);
