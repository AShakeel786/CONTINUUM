import { describe, expect, it } from "vitest";
import { orderBlocks } from "../ordering.js";
import type { ContextBlock } from "../types.js";

function block(id: string, cls: ContextBlock["class"], score?: number): ContextBlock {
  return {
    id,
    class: cls,
    content: `content-${id}`,
    priority: 50,
    provenance: { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z", score },
  };
}

describe("orderBlocks — deterministic ordering", () => {
  it("orders stable classes in the fixed sequence regardless of input order", () => {
    const input = [
      block("a", "static-tools"),
      block("b", "instructions"),
      block("c", "scene-index"),
      block("d", "persona"),
      block("e", "project-context"),
    ];
    const ordered = orderBlocks(input).map((b) => b.id);
    expect(ordered).toEqual(["b", "e", "d", "c", "a"]);
  });

  it("orders dynamic classes in the fixed sequence regardless of input order", () => {
    const input = [
      block("a", "tool-results"),
      block("b", "recalled-memory"),
      block("c", "recent-conversation"),
      block("d", "current-task"),
    ];
    const ordered = orderBlocks(input).map((b) => b.id);
    expect(ordered).toEqual(["b", "d", "c", "a"]);
  });

  it("is idempotent and identical across repeated calls on the same (shuffled) input", () => {
    const input = [
      block("z", "recalled-memory", 0.2),
      block("a", "persona"),
      block("m", "recalled-memory", 0.9),
    ];
    const first = orderBlocks(input).map((b) => b.id);
    const shuffled = [input[2]!, input[0]!, input[1]!];
    const second = orderBlocks(shuffled).map((b) => b.id);
    expect(first).toEqual(second);
  });

  it("within the same class, orders by provenance score descending", () => {
    const input = [
      block("low", "recalled-memory", 0.1),
      block("high", "recalled-memory", 0.9),
      block("mid", "recalled-memory", 0.5),
    ];
    expect(orderBlocks(input).map((b) => b.id)).toEqual(["high", "mid", "low"]);
  });

  it("scored blocks sort before unscored blocks of the same class", () => {
    const input = [block("unscored", "recalled-memory"), block("scored", "recalled-memory", 0.4)];
    expect(orderBlocks(input).map((b) => b.id)).toEqual(["scored", "unscored"]);
  });

  it("ties (same class, no score difference) break deterministically on id", () => {
    const input = [block("b", "persona"), block("a", "persona")];
    expect(orderBlocks(input).map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [block("b", "persona"), block("a", "persona")];
    const copy = [...input];
    orderBlocks(input);
    expect(input).toEqual(copy);
  });
});
