import { describe, expect, it } from "vitest";
import { diffStableBlocks, summarizeBlockDiff } from "../block-diff.js";
import type { ContextBlock } from "../../context/types.js";

function block(id: string, cls: ContextBlock["class"], content: string): ContextBlock {
  return { id, class: cls, content, priority: 10, provenance: { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z" } };
}

describe("diffStableBlocks — precise per-block cache-invalidation diff", () => {
  it("reports unchanged when content is identical", () => {
    const a = [block("persona", "persona", "P")];
    const b = [block("persona", "persona", "P")];
    const diff = diffStableBlocks(a, b);
    expect(diff).toEqual([{ blockId: "persona", class: "persona", changeType: "unchanged", previousHash: expect.any(String), currentHash: expect.any(String) }]);
  });

  it("identifies exactly which block was modified, leaving others unchanged", () => {
    const previous = [block("persona", "persona", "P v1"), block("scene", "scene-index", "S")];
    const current = [block("persona", "persona", "P v2"), block("scene", "scene-index", "S")];
    const diff = diffStableBlocks(previous, current);

    const personaDiff = diff.find((d) => d.blockId === "persona");
    const sceneDiff = diff.find((d) => d.blockId === "scene");
    expect(personaDiff?.changeType).toBe("modified");
    expect(sceneDiff?.changeType).toBe("unchanged");
  });

  it("identifies an added block", () => {
    const previous = [block("persona", "persona", "P")];
    const current = [block("persona", "persona", "P"), block("scene", "scene-index", "S")];
    const diff = diffStableBlocks(previous, current);
    const added = diff.find((d) => d.blockId === "scene");
    expect(added?.changeType).toBe("added");
    expect(added?.previousHash).toBeUndefined();
  });

  it("identifies a removed block", () => {
    const previous = [block("persona", "persona", "P"), block("scene", "scene-index", "S")];
    const current = [block("persona", "persona", "P")];
    const diff = diffStableBlocks(previous, current);
    const removed = diff.find((d) => d.blockId === "scene");
    expect(removed?.changeType).toBe("removed");
    expect(removed?.currentHash).toBeUndefined();
  });

  it("handles empty previous (first-ever turn) as all-added", () => {
    const diff = diffStableBlocks([], [block("persona", "persona", "P")]);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.changeType).toBe("added");
  });

  it("handles empty current (everything removed) correctly", () => {
    const diff = diffStableBlocks([block("persona", "persona", "P")], []);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.changeType).toBe("removed");
  });
});

describe("summarizeBlockDiff", () => {
  it("reports 'no changes' when everything is unchanged", () => {
    const diff = diffStableBlocks([block("p", "persona", "X")], [block("p", "persona", "X")]);
    expect(summarizeBlockDiff(diff)).toBe("no changes");
  });

  it("names only the changed blocks, not unchanged ones", () => {
    const previous = [block("p", "persona", "old"), block("s", "scene-index", "same")];
    const current = [block("p", "persona", "new"), block("s", "scene-index", "same")];
    const summary = summarizeBlockDiff(diffStableBlocks(previous, current));
    expect(summary).toContain("modified (persona:p)");
    expect(summary).not.toContain("scene-index:s");
  });
});
