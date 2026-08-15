import { describe, expect, it } from "vitest";
import { allocateBudget } from "../budget.js";
import { estimateTokens } from "../tokenizer.js";
import type { ContextBlock, ContextEnvelope } from "../../context/types.js";

function block(id: string, cls: ContextBlock["class"], content: string, priority: number, score?: number): ContextBlock {
  return {
    id,
    class: cls,
    content,
    priority,
    provenance: { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z", score },
  };
}

const repeatWords = (word: string, n: number) => Array.from({ length: n }, () => word).join(" ");

function envelope(stable: ContextBlock[], dynamic: ContextBlock[]): ContextEnvelope {
  return {
    stable: { blocks: stable },
    dynamic: { blocks: dynamic },
    metadata: { sessionKey: "s", query: "q", assembledAt: "2026-01-01T00:00:00.000Z" },
  };
}

describe("allocateBudget — token budgeting and deterministic trimming", () => {
  it("leaves the envelope untouched when everything fits within budget", () => {
    const env = envelope(
      [block("instr", "instructions", "Be helpful.", 0)],
      [block("mem-1", "recalled-memory", "Short memory.", 80)],
    );
    const result = allocateBudget(env, { contextWindow: 100_000, reservedOutput: 4096 });
    expect(result.trimEvents).toHaveLength(0);
    expect(result.envelope).toEqual(env);
    expect(result.inputTokensBefore).toEqual(result.inputTokensAfter);
  });

  it("exposes before/after token counts even when nothing was trimmed", () => {
    const env = envelope([block("instr", "instructions", "hello world", 0)], []);
    const result = allocateBudget(env, { contextWindow: 100_000, reservedOutput: 0 });
    expect(result.inputTokensBefore.tokens).toBeGreaterThan(0);
    expect(result.availableForInput).toBe(100_000);
  });

  it("drops the lowest-priority (highest priority number) recalled-memory block first when over budget", () => {
    const big = repeatWords("filler", 2000); // large enough to force trimming
    const env = envelope(
      [block("persona", "persona", "Persona summary.", 10)],
      [
        block("mem-low", "recalled-memory", big, 90, 0.1),
        block("mem-high", "recalled-memory", "Important recalled fact.", 80, 0.9),
      ],
    );
    // Tight budget: only enough room for persona + one small memory, not the big one.
    const personaTokens = estimateTokens("Persona summary.").tokens;
    const smallMemTokens = estimateTokens("Important recalled fact.").tokens;
    const result = allocateBudget(env, { contextWindow: personaTokens + smallMemTokens + 5, reservedOutput: 0 });

    const droppedIds = result.trimEvents.filter((e) => e.action === "dropped").map((e) => e.blockId);
    expect(droppedIds).toContain("mem-low");
    expect(result.envelope.dynamic.blocks.map((b) => b.id)).toContain("mem-high");
  });

  it("never touches the instructions class, even under extreme pressure", () => {
    const env = envelope(
      [block("instr", "instructions", "Critical system instructions.", 0)],
      [block("mem-1", "recalled-memory", repeatWords("filler", 5000), 80)],
    );
    const instrTokens = estimateTokens("Critical system instructions.").tokens;
    const result = allocateBudget(env, { contextWindow: instrTokens + 10, reservedOutput: 0 });

    const instrBlock = result.envelope.stable.blocks.find((b) => b.class === "instructions");
    expect(instrBlock?.content).toBe("Critical system instructions.");
    expect(result.trimEvents.some((e) => e.class === "instructions")).toBe(false);
  });

  it("flags criticalContentOverBudget and changes nothing when instructions alone exceed the budget", () => {
    const bigInstructions = repeatWords("critical", 5000);
    const env = envelope([block("instr", "instructions", bigInstructions, 0)], [block("mem-1", "recalled-memory", "x", 80)]);
    const result = allocateBudget(env, { contextWindow: 10, reservedOutput: 0 });

    expect(result.criticalContentOverBudget).toBe(true);
    expect(result.trimEvents).toHaveLength(0);
    expect(result.envelope).toEqual(env); // completely unchanged, not a best-effort cut
  });

  it("truncates (not just drops) a block that partially fits the remaining budget", () => {
    const longMemory = repeatWords("word", 500);
    const env = envelope([], [block("mem-1", "recalled-memory", longMemory, 80)]);
    const fullTokens = estimateTokens(longMemory).tokens;
    const result = allocateBudget(env, { contextWindow: Math.floor(fullTokens / 2), reservedOutput: 0 });

    const truncateEvent = result.trimEvents.find((e) => e.blockId === "mem-1");
    expect(truncateEvent?.action).toBe("truncated");
    expect(truncateEvent!.tokensAfter).toBeLessThan(truncateEvent!.tokensBefore);
    const survivingBlock = result.envelope.dynamic.blocks.find((b) => b.id === "mem-1");
    expect(survivingBlock?.content).toContain("truncated by token budget");
  });

  it("produces identical results across repeated runs on the same input (deterministic)", () => {
    const env = envelope(
      [block("persona", "persona", "Persona.", 10), block("scene", "scene-index", repeatWords("scene", 200), 20)],
      [
        block("mem-a", "recalled-memory", "A", 80, 0.5),
        block("mem-b", "recalled-memory", "B", 80, 0.5),
        block("mem-c", "recalled-memory", repeatWords("c", 300), 90),
      ],
    );
    const limits = { contextWindow: 50, reservedOutput: 0 };
    const first = allocateBudget(env, limits);
    const second = allocateBudget(env, limits);
    expect(first.trimEvents).toEqual(second.trimEvents);
    expect(first.envelope).toEqual(second.envelope);
  });

  it("every trim event carries a human-readable reason", () => {
    const env = envelope([], [block("mem-1", "recalled-memory", repeatWords("x", 1000), 80)]);
    const result = allocateBudget(env, { contextWindow: 5, reservedOutput: 0 });
    for (const event of result.trimEvents) {
      expect(event.reason.length).toBeGreaterThan(0);
    }
  });
});
