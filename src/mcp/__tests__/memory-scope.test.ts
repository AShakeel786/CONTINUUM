import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "../build.js";
import type { MemoryCoreGatewayConfig } from "../../context/memorycore-client.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cont-mcp-scope-"));
}

const baseCfg: MemoryCoreGatewayConfig = {
  baseUrl: "http://memcore.test",
  serviceToken: { envVar: "T" },
  serviceId: "s",
  teamId: "team",
  userId: "u",
  agentId: "default",
  resolveToken: async () => "tok",
};

describe("MCP server memory project scoping", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("scopes every gateway request to the project's bucket when memoryProjectScope is set", async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers?: Record<string, string> }) => {
      seen.push(init.headers?.["x-tdai-agent-id"] ?? null);
      return { ok: true, status: 200, json: async () => ({ data: { content: "", entries: [] } }), text: async () => "{}" };
    });

    const registry = await buildToolRegistry({
      dataDir: tmp(),
      memoryProvider: async () => baseCfg,
      memoryProjectScope: "proj-XYZ",
    });
    await registry.call("memory_recall", {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === "project-proj-XYZ")).toBe(true);
    expect(seen).not.toContain("default");
  });

  it("uses the base identity when no project scope is supplied (general / no-project)", async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers?: Record<string, string> }) => {
      seen.push(init.headers?.["x-tdai-agent-id"] ?? null);
      return { ok: true, status: 200, json: async () => ({ data: { content: "", entries: [] } }), text: async () => "{}" };
    });
    const registry = await buildToolRegistry({ dataDir: tmp(), memoryProvider: async () => baseCfg });
    await registry.call("memory_recall", {});
    expect(seen.every((s) => s === "default")).toBe(true);
  });

  it("returns no config (no fallback) rather than an unscoped one when the base provider is unconfigured", async () => {
    const registry = await buildToolRegistry({
      dataDir: tmp(),
      memoryProvider: async () => undefined,
      memoryProjectScope: "proj-XYZ",
    });
    const res = await registry.call("memory_recall", {});
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join("")).toContain("not configured");
  });
});
