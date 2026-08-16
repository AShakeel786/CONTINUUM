import { describe, expect, it } from "vitest";
import { parseRequest, serializeMessage, makeResponse, makeError, JSONRPC_METHOD_NOT_FOUND } from "../protocol.js";

describe("protocol framing", () => {
  it("serializes a response to a single newline-terminated JSON line", () => {
    const line = serializeMessage(makeResponse(1, { ok: true }));
    expect(line).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(line.replace(/[^\n]/g, "")).toBe("\n"); // exactly one newline
  });

  it("parses a valid request line", () => {
    const req = parseRequest('{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}');
    expect(req?.method).toBe("tools/list");
    expect(req?.id).toBe(7);
  });

  it("returns undefined for a blank line, throws for malformed input", () => {
    expect(parseRequest("   ")).toBeUndefined();
    expect(() => parseRequest("not json")).toThrow();
    expect(() => parseRequest('{"jsonrpc":"1.0","method":"x"}')).toThrow();
  });

  it("builds a method-not-found error", () => {
    const e = makeError(9, JSONRPC_METHOD_NOT_FOUND, "Method not found: nope");
    expect(e.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);
    expect(e.id).toBe(9);
  });
});
