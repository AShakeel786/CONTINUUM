import { describe, expect, it } from "vitest";
import { canonicalStringify } from "../canonical-json.js";

describe("canonicalStringify — deterministic serialization", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("sorts keys recursively, including nested objects and arrays of objects", () => {
    const value = { z: { y: 1, x: 2 }, a: [{ q: 1, p: 2 }, { b: 1, a: 2 }] };
    const other = { a: [{ p: 2, q: 1 }, { a: 2, b: 1 }], z: { x: 2, y: 1 } };
    expect(canonicalStringify(value)).toBe(canonicalStringify(other));
  });

  it("differs when actual content differs", () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 2 }));
  });

  it("preserves array element order (only object keys are sorted, not array contents)", () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
  });
});
