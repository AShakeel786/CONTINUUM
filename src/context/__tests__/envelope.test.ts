import { describe, expect, it } from "vitest";
import { buildContextEnvelope } from "../envelope.js";
import type { ContextBlock } from "../types.js";
import type { FetchedDynamicRecall, FetchedStableContent } from "../memorycore-client.js";

const stableFixture: FetchedStableContent = {
  persona: { content: "User likes concise answers.", updatedAt: "2026-01-01T00:00:00.000Z" },
  sceneIndex: [{ path: "scenes/trip.md", summary: "Japan trip planning" }],
};

const dynamicFixture: FetchedDynamicRecall = {
  items: [
    { id: "mem-1", type: "episodic", content: "Discussed Japan trip budget.", score: 0.87 },
    { id: "mem-2", type: "instruction", content: "Always answer in English.", score: 0.42 },
  ],
};

function callerBlock(id: string, cls: ContextBlock["class"]): ContextBlock {
  return {
    id,
    class: cls,
    content: `content-${id}`,
    priority: 5,
    provenance: { source: "caller", fetchedAt: "2026-01-01T00:00:00.000Z" },
  };
}

describe("buildContextEnvelope — the one assembly path", () => {
  it("keeps stable and dynamic content in strictly separate sections", () => {
    const envelope = buildContextEnvelope({
      sessionKey: "sess-1",
      query: "japan trip",
      memoryCore: { stable: stableFixture, dynamic: dynamicFixture },
    });

    const stableClasses = envelope.stable.blocks.map((b) => b.class);
    const dynamicClasses = envelope.dynamic.blocks.map((b) => b.class);
    expect(stableClasses).toEqual(expect.arrayContaining(["persona", "scene-index"]));
    expect(dynamicClasses).toEqual(["recalled-memory", "recalled-memory"]);
    // No overlap: nothing in stable appears in dynamic or vice versa.
    for (const cls of stableClasses) expect(dynamicClasses).not.toContain(cls);
  });

  it("maps MemoryCore recall items into individually provenanced blocks, ordered by score", () => {
    const envelope = buildContextEnvelope({
      sessionKey: "sess-1",
      query: "japan trip",
      memoryCore: { stable: stableFixture, dynamic: dynamicFixture },
    });
    const recalled = envelope.dynamic.blocks.filter((b) => b.class === "recalled-memory");
    expect(recalled).toHaveLength(2);
    expect(recalled[0]!.provenance.sourceId).toBe("mem-1"); // higher score (0.87) first
    expect(recalled[0]!.provenance.source).toBe("memorycore-gateway:/v3/atomic/search");
    expect(recalled[1]!.provenance.sourceId).toBe("mem-2");
  });

  it("merges caller-supplied blocks with MemoryCore blocks in the correct sections", () => {
    const envelope = buildContextEnvelope({
      sessionKey: "sess-1",
      query: "japan trip",
      callerBlocks: [
        callerBlock("instr-1", "instructions"),
        callerBlock("task-1", "current-task"),
      ],
      memoryCore: { stable: stableFixture, dynamic: dynamicFixture },
    });
    expect(envelope.stable.blocks.map((b) => b.id)).toContain("instr-1");
    expect(envelope.dynamic.blocks.map((b) => b.id)).toContain("task-1");
    // instructions class sorts before persona/scene-index per the fixed class order.
    expect(envelope.stable.blocks[0]!.id).toBe("instr-1");
  });

  it("works with no MemoryCore input at all (pure caller-supplied envelope)", () => {
    const envelope = buildContextEnvelope({
      sessionKey: "sess-1",
      query: "hello",
      callerBlocks: [callerBlock("instr-1", "instructions"), callerBlock("conv-1", "recent-conversation")],
    });
    expect(envelope.stable.blocks).toHaveLength(1);
    expect(envelope.dynamic.blocks).toHaveLength(1);
  });

  it("rejects a caller block that claims a MemoryCore-reserved class", () => {
    expect(() =>
      buildContextEnvelope({
        sessionKey: "sess-1",
        query: "hello",
        callerBlocks: [callerBlock("fake-persona", "persona")],
      }),
    ).toThrow(/MemoryCore-reserved class/);
  });

  it("rejects a caller block claiming recalled-memory (the dynamic reserved class)", () => {
    expect(() =>
      buildContextEnvelope({
        sessionKey: "sess-1",
        query: "hello",
        callerBlocks: [callerBlock("fake-recall", "recalled-memory")],
      }),
    ).toThrow(/MemoryCore-reserved class/);
  });

  it("produces a JSON-serializable envelope with no secret-shaped content", () => {
    const envelope = buildContextEnvelope({
      sessionKey: "sess-1",
      query: "japan trip",
      memoryCore: { stable: stableFixture, dynamic: dynamicFixture },
    });
    const json = JSON.stringify(envelope);
    expect(json).not.toMatch(/sk-[a-zA-Z0-9_-]{8,}/);
    expect(json).not.toMatch(/-----BEGIN/);
  });

  it("empty MemoryCore results produce an envelope with no persona/scene-index/recalled-memory blocks", () => {
    const envelope = buildContextEnvelope({
      sessionKey: "sess-1",
      query: "nothing relevant",
      memoryCore: { stable: { persona: null, sceneIndex: [] }, dynamic: { items: [] } },
    });
    expect(envelope.stable.blocks).toHaveLength(0);
    expect(envelope.dynamic.blocks).toHaveLength(0);
  });

  it("stamps metadata (sessionKey, query, assembledAt) without leaking secrets into extra", () => {
    const envelope = buildContextEnvelope({
      sessionKey: "sess-1",
      query: "japan trip",
      extra: { teamId: "team-x", agentId: "agent-y" },
    });
    expect(envelope.metadata.sessionKey).toBe("sess-1");
    expect(envelope.metadata.query).toBe("japan trip");
    expect(envelope.metadata.assembledAt).toBeTruthy();
    expect(envelope.metadata.extra).toEqual({ teamId: "team-x", agentId: "agent-y" });
  });
});
