import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDynamicRecallFromMemoryCore, fetchStableFromMemoryCore } from "../memorycore-client.js";
import { buildContextEnvelope } from "../envelope.js";
import { secretRef } from "../../providers/secrets.js";
import { MissingSecretError } from "../../providers/errors.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const baseCfg = {
  baseUrl: "http://127.0.0.1:8420",
  serviceToken: secretRef("TEST_MEMORYCORE_TOKEN"),
  serviceId: "default",
  teamId: "team-x",
  userId: "user-x",
  agentId: "agent-x",
  taskId: "task-x",
  sessionId: "sess-x",
};

describe("MemoryCore Gateway client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_MEMORYCORE_TOKEN;
  });

  it("fetches persona + scene index via /v3/core/read and /v3/scenario/ls with correct isolation headers", async () => {
    process.env.TEST_MEMORYCORE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v3/core/read")) {
        return jsonResponse({ code: 0, data: { content: "User is a backend engineer.", updated_at: "2026-01-01T00:00:00.000Z" } });
      }
      if (u.endsWith("/v3/scenario/ls")) {
        return jsonResponse({ code: 0, data: { entries: [{ path: "scenes/onboarding.md", summary: "Onboarding notes" }] } });
      }
      throw new Error(`unexpected URL in test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchStableFromMemoryCore(baseCfg);

    expect(result.persona?.content).toBe("User is a backend engineer.");
    expect(result.sceneIndex).toEqual([{ path: "scenes/onboarding.md", summary: "Onboarding notes", updatedAt: undefined }]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-mem-test-fixture");
    expect(headers.get("x-tdai-team-id")).toBe("team-x");
    expect(headers.get("x-tdai-agent-id")).toBe("agent-x");
  });

  it("fetches L1 recall via /v3/atomic/search with the query and isolation headers", async () => {
    process.env.TEST_MEMORYCORE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: {
          items: [
            { id: "mem-1", type: "episodic", content: "Discussed deployment plan.", score: 0.75, updated_at: "2026-01-01" },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDynamicRecallFromMemoryCore(baseCfg, "deployment plan");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("mem-1");
    expect(result.items[0]!.score).toBe(0.75);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("deployment plan");
    expect(body.team_id).toBe("team-x");
    expect(body.session_id).toBe("sess-x");
    expect(body.task_id).toBe("task-x");
  });

  it("returns an empty result (no request made) for a blank query — matches TdaiClient's existing behavior", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchDynamicRecallFromMemoryCore(baseCfg, "   ");
    expect(result.items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws MissingSecretError (not a fetch call) when the service token env var is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchStableFromMemoryCore(baseCfg)).rejects.toThrow(MissingSecretError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a non-2xx Gateway response as a thrown error, not a silent empty result", async () => {
    process.env.TEST_MEMORYCORE_TOKEN = "sk-mem-test-fixture";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    await expect(fetchStableFromMemoryCore(baseCfg)).rejects.toThrow(/HTTP 401/);
  });

  it("end-to-end: a real MemoryCore recall round-trip maps into a valid ContextEnvelope", async () => {
    process.env.TEST_MEMORYCORE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v3/core/read")) return jsonResponse({ code: 0, data: { content: "Persona content." } });
      if (u.endsWith("/v3/scenario/ls")) return jsonResponse({ code: 0, data: { entries: [] } });
      if (u.endsWith("/v3/atomic/search")) {
        return jsonResponse({ code: 0, data: { items: [{ id: "mem-9", type: "instruction", content: "Be concise.", score: 0.6 }] } });
      }
      throw new Error(`unexpected URL: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const stable = await fetchStableFromMemoryCore(baseCfg);
    const dynamic = await fetchDynamicRecallFromMemoryCore(baseCfg, "be concise");
    const envelope = buildContextEnvelope({
      sessionKey: "sess-x",
      query: "be concise",
      memoryCore: { stable, dynamic, recallStrategy: "hybrid" },
    });

    expect(envelope.stable.blocks.some((b) => b.class === "persona")).toBe(true);
    expect(envelope.dynamic.blocks).toHaveLength(1);
    expect(envelope.dynamic.blocks[0]!.provenance.sourceId).toBe("mem-9");
    expect(envelope.metadata.recallStrategy).toBe("hybrid");
  });
});
