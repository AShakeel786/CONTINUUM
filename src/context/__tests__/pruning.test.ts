import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateBudget } from "../../token/budget.js";
import { applyReversiblePruning, FilePruneStore, type PruneStore } from "../pruning.js";
import type { ContextBlock, ContextEnvelope } from "../types.js";

function block(id: string, cls: ContextBlock["class"], content: string, priority = 50): ContextBlock {
  return { id, class: cls, content, priority, provenance: { source: "test", fetchedAt: new Date().toISOString() } };
}

function env(blocks: ContextBlock[]): ContextEnvelope {
  const stable = blocks.filter((b) => b.class === "instructions" || b.class === "project-context" || b.class === "persona" || b.class === "scene-index" || b.class === "static-tools");
  const dynamic = blocks.filter((b) => !stable.includes(b));
  return { stable: { blocks: stable }, dynamic: { blocks: dynamic }, metadata: { sessionKey: "s1", query: "q", assembledAt: new Date().toISOString() } };
}

class MemStore implements PruneStore {
  readonly telemetry = { retrievalCount: 0, restorationFailures: 0 };
  map = new Map<string, string>();
  async put(_s: string, _b: string, content: string) { const id = `ref-${this.map.size}`; this.map.set(id, content); return id; }
  async get(refId: string) { return this.map.get(refId); }
  async clearSession() { return this.map.size; }
}

const bigRecall = "RECALLED MEMORY ".repeat(50); // large prunable content
const bigTool = "TOOL RESULT ".repeat(50);

describe("applyReversiblePruning", () => {
  it("prunes eligible blocks, preserves instructions + current-task, and retrieves byte-for-byte", async () => {
    const instructions = block("i1", "instructions", "DO NOT PRUNE: critical system constraints", 0);
    const currentTask = block("t1", "current-task", "The active task goal", 0);
    const recall = block("r1", "recalled-memory", bigRecall, 100);
    const tool = block("tr1", "tool-results", bigTool, 100);
    const e = env([instructions, currentTask, recall, tool]);

    const budget = allocateBudget(e, { contextWindow: 150, reservedOutput: 32 });
    const store = new MemStore();
    const result = await applyReversiblePruning(e, budget, store, "s1");

    const all = [...result.envelope.stable.blocks, ...result.envelope.dynamic.blocks];
    // instructions + current-task preserved verbatim
    expect(all.find((b) => b.id === "i1")?.content).toContain("critical");
    expect(all.find((b) => b.id === "t1")?.content).toContain("active task goal");
    // recalled-memory + tool-results pruned (references present)
    expect(result.pruned.map((p) => p.class).sort()).toEqual(["recalled-memory", "tool-results"]);
    expect(all.some((b) => b.id.endsWith(":pruned-ref"))).toBe(true);
    // byte-for-byte retrieval
    const ref = result.pruned.find((p) => p.class === "recalled-memory")!;
    expect(await store.get(ref.refId)).toBe(bigRecall);
    expect(result.telemetry.blocksPruned).toBe(2);
    expect(result.telemetry.tokensExternalized).toBeGreaterThan(0);
  });

  it("fail-closed: a throwing store keeps the original block (never discards)", async () => {
    const recall = block("r1", "recalled-memory", bigRecall, 100);
    const e = env([block("i1", "instructions", "keep me", 0), recall]);
    const budget = allocateBudget(e, { contextWindow: 80, reservedOutput: 0 });
    const throwing: PruneStore = { telemetry: { retrievalCount: 0, restorationFailures: 0 }, put: async () => { throw new Error("disk full"); }, get: async () => undefined, clearSession: async () => 0 };
    const result = await applyReversiblePruning(e, budget, throwing, "s1");
    // the original recall block is kept (not pruned), since persistence failed
    const all = [...result.envelope.stable.blocks, ...result.envelope.dynamic.blocks];
    expect(all.some((b) => b.id === "r1")).toBe(true);
    expect(result.pruned).toEqual([]);
  });

  it("FilePruneStore persists and retrieves after a restart (new instance)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-"));
    const s1 = new FilePruneStore(dir);
    const refId = await s1.put("sessA", "b1", "full content here");
    // simulate restart: new store instance reads from the same disk dir
    const s2 = new FilePruneStore(dir);
    expect(await s2.get(refId)).toBe("full content here");
  });
});
