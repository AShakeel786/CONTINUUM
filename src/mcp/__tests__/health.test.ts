import { describe, expect, it } from "vitest";
import { verifyMcpHealth, type McpHealthDeps } from "../health.js";

const NODE_COMMAND = [process.execPath, "/tmp/continuum/dist/mcp/bin.js"] as const;

describe("verifyMcpHealth", () => {
  it("reports reachable when the initialize handshake succeeds", async () => {
    const deps: McpHealthDeps = {
      exists: async () => true,
      handshake: async () => "reachable",
    };
    const result = await verifyMcpHealth(NODE_COMMAND, deps);
    expect(result.status).toBe("reachable");
  });

  it("reports protocol-failure when the server responds but the handshake fails", async () => {
    const deps: McpHealthDeps = {
      exists: async () => true,
      handshake: async () => "protocol-failure",
    };
    const result = await verifyMcpHealth(NODE_COMMAND, deps);
    expect(result.status).toBe("protocol-failure");
  });

  it("reports executable-missing when the server fails to launch", async () => {
    const deps: McpHealthDeps = {
      exists: async () => true,
      handshake: async () => "executable-missing",
    };
    const result = await verifyMcpHealth(NODE_COMMAND, deps);
    expect(result.status).toBe("executable-missing");
  });

  it("reports stale-path when the server script is missing (no handshake attempted)", async () => {
    let handshakeCalled = false;
    const deps: McpHealthDeps = {
      exists: async () => false,
      handshake: async () => {
        handshakeCalled = true;
        return "reachable";
      },
    };
    const result = await verifyMcpHealth(NODE_COMMAND, deps);
    expect(result.status).toBe("stale-path");
    expect(result.detail).toContain("missing");
    expect(handshakeCalled).toBe(false);
  });

  it("does not leak secrets in any result detail", async () => {
    const deps: McpHealthDeps = { exists: async () => true, handshake: async () => "protocol-failure" };
    const result = await verifyMcpHealth(NODE_COMMAND, deps);
    expect(JSON.stringify(result)).not.toMatch(/sk-|Bearer|token=/i);
  });
});
