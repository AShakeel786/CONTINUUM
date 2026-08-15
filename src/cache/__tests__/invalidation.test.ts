import { describe, expect, it } from "vitest";
import { hashStablePrefix, PrefixStabilityTracker } from "../invalidation.js";
import type { ContextBlock, ContextEnvelope } from "../../context/types.js";

function block(id: string, cls: ContextBlock["class"], content: string): ContextBlock {
  return { id, class: cls, content, priority: 10, provenance: { source: "test", fetchedAt: "2026-01-01T00:00:00.000Z" } };
}

function envelope(sessionKey: string, stable: ContextBlock[]): ContextEnvelope {
  return {
    stable: { blocks: stable },
    dynamic: { blocks: [] },
    metadata: { sessionKey, query: "q", assembledAt: "2026-01-01T00:00:00.000Z" },
  };
}

describe("hashStablePrefix — determinism", () => {
  it("produces the same hash for the same content regardless of input block order", () => {
    const a = envelope("s", [block("x", "persona", "P"), block("y", "instructions", "I")]);
    const b = envelope("s", [block("y", "instructions", "I"), block("x", "persona", "P")]);
    expect(hashStablePrefix(a)).toBe(hashStablePrefix(b));
  });

  it("produces a different hash when content changes", () => {
    const a = envelope("s", [block("x", "persona", "P v1")]);
    const b = envelope("s", [block("x", "persona", "P v2")]);
    expect(hashStablePrefix(a)).not.toBe(hashStablePrefix(b));
  });
});

describe("PrefixStabilityTracker — cache invalidation detection", () => {
  it("reports stable=true (no previous hash to compare) on the first turn of a session", () => {
    const tracker = new PrefixStabilityTracker();
    const result = tracker.check(envelope("sess-1", [block("x", "persona", "P")]));
    expect(result.stable).toBe(true);
    expect(result.previousHash).toBeUndefined();
  });

  it("reports stable=true when the stable prefix is byte-identical across turns", () => {
    const tracker = new PrefixStabilityTracker();
    const env = envelope("sess-1", [block("x", "persona", "P")]);
    tracker.check(env);
    const second = tracker.check(env);
    expect(second.stable).toBe(true);
  });

  it("detects invalidation when the stable prefix changes, with a reason", () => {
    const tracker = new PrefixStabilityTracker();
    tracker.check(envelope("sess-1", [block("x", "persona", "P v1")]));
    const second = tracker.check(envelope("sess-1", [block("x", "persona", "P v2")]));
    expect(second.stable).toBe(false);
    expect(second.invalidationReason).toBeTruthy();
    expect(second.previousHash).not.toBe(second.currentHash);
  });

  it("tracks sessions independently — one session's changes don't invalidate another's", () => {
    const tracker = new PrefixStabilityTracker();
    tracker.check(envelope("sess-A", [block("x", "persona", "A content")]));
    tracker.check(envelope("sess-B", [block("y", "persona", "B content")]));
    const resultA = tracker.check(envelope("sess-A", [block("x", "persona", "A content")]));
    expect(resultA.stable).toBe(true);
  });

  it("forget() clears tracked state so the next check behaves like a first turn", () => {
    const tracker = new PrefixStabilityTracker();
    tracker.check(envelope("sess-1", [block("x", "persona", "P")]));
    tracker.forget("sess-1");
    const result = tracker.check(envelope("sess-1", [block("x", "persona", "different")]));
    expect(result.previousHash).toBeUndefined();
    expect(result.stable).toBe(true);
  });
});
