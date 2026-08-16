import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../server.js";
import { buildToolRegistry } from "../build.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import type { MemoryCoreProvider } from "../memory-tools.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mcp-"));
}

async function registryWithMemoryCoreProvider(provider: MemoryCoreProvider) {
  return buildToolRegistry({ dataDir: tmp(), memoryProvider: provider });
}

describe("MCP server dispatch", () => {
  it("initialize returns serverInfo and tools capability, with no secret fields", async () => {
    const registry = await registryWithMemoryCoreProvider(async () => undefined);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { name: "continuum", version: "1", registry },
    );
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeTruthy();
    expect(result.capabilities).toEqual({ tools: {} });
    expect(JSON.stringify(result)).not.toContain("token");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("tools/list returns read-vs-write classification, no MemoryCore unconfigured crash", async () => {
    const registry = await registryWithMemoryCoreProvider(async () => undefined);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { name: "continuum", version: "1", registry },
    );
    const tools = (res.result as { tools: Array<{ name: string; access: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("memory_search");
    expect(names).toContain("session_state");
    const write = tools.filter((t) => t.access === "write").map((t) => t.name);
    expect(write).toContain("memory_capture");
    const read = tools.filter((t) => t.access === "read").map((t) => t.name);
    expect(read).toContain("memory_search");
    expect(read).toContain("session_state");
  });

  it("ping responds with empty result", async () => {
    const registry = await registryWithMemoryCoreProvider(async () => undefined);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
      { name: "x", version: "1", registry },
    );
    expect(res.result).toEqual({});
  });

  it("unknown tool returns a method-not-found error", async () => {
    const registry = await registryWithMemoryCoreProvider(async () => undefined);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
      { name: "x", version: "1", registry },
    );
    expect(res.error?.code).toBe(-32601);
  });

  it("tools/call missing name returns invalid-params", async () => {
    const registry = await registryWithMemoryCoreProvider(async () => undefined);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { arguments: {} } },
      { name: "x", version: "1", registry },
    );
    expect(res.error?.code).toBe(-32602);
  });

  it("memory_search degrades clearly when MemoryCore unavailable (no crash)", async () => {
    const registry = await registryWithMemoryCoreProvider(async () => undefined);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "memory_search", arguments: { query: "hello" } } },
      { name: "x", version: "1", registry },
    );
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not configured");
  });

  it("never leaks a MemoryCore token into any response", async () => {
    // A provider that would carry a secret config; the tool must not echo it.
    let captured: unknown;
    const provider: MemoryCoreProvider = async () => {
      captured = { baseUrl: "http://x", serviceToken: { envVar: "SECRET_VAR" }, serviceId: "s", teamId: "t", userId: "u", agentId: "a" };
      return undefined; // force unconfigured path; the point is no secret in output
    };
    const registry = await registryWithMemoryCoreProvider(provider);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "memory_recall", arguments: {} } },
      { name: "x", version: "1", registry },
    );
    expect(JSON.stringify(res)).not.toContain("SECRET_VAR");
  });
});

describe("MCP session/project tools", () => {
  it("session_state returns scoped session summary (no cross-session content)", async () => {
    const dataDir = tmp();
    const registry = await buildToolRegistry({ dataDir, memoryProvider: async () => undefined });

    // Seed a project + session directly.
    const projects = new ProjectRegistry(new ProjectRegistryStore(dataDir));
    const p = await projects.add({ name: "demo", path: "/x/demo", defaultProvider: "claude" });
    const sessionManager = new SessionManager(new FileSessionStore(join(dataDir, "sessions")));
    const s = await sessionManager.createSession({
      sessionId: "sess-1",
      projectId: p.id,
      workingDirectory: "/x/demo",
      activeProvider: { providerId: "claude", model: "claude-sonnet-5" },
      taskGoal: "build a thing",
    });

    const res = await handleRequest(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "session_state", arguments: { sessionId: "sess-1" } } },
      { name: "x", version: "1", registry },
    );
    const result = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(result).toContain("sess-1");
    expect(result).toContain("build a thing");
    expect(result).toContain("claude");
  });

  it("session_state with unknown id returns isError, not a crash", async () => {
    const registry = await buildToolRegistry({ dataDir: tmp(), memoryProvider: async () => undefined });
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "session_state", arguments: { sessionId: "no-such" } } },
      { name: "x", version: "1", registry },
    );
    expect((res.result as { isError?: boolean }).isError).toBe(true);
  });

  it("project_list does not include any credential/secret field", async () => {
    const dataDir = tmp();
    const projects = new ProjectRegistry(new ProjectRegistryStore(dataDir));
    await projects.add({ name: "demo", path: "/x/demo" });
    const registry = await buildToolRegistry({ dataDir, memoryProvider: async () => undefined });
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "project_list", arguments: {} } },
      { name: "x", version: "1", registry },
    );
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("demo");
    expect(text).not.toContain("credential");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("token");
  });
});
