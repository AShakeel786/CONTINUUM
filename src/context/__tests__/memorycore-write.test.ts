import { afterEach, describe, expect, it, vi } from "vitest";
import { captureConversation, captureTurn, updateAtomicMemory } from "../memorycore-write.js";
import { secretRef } from "../../providers/secrets.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const baseCfg = {
  baseUrl: "http://127.0.0.1:8420",
  serviceToken: secretRef("TEST_WRITE_TOKEN"),
  serviceId: "default",
  teamId: "team-x",
  userId: "user-x",
  agentId: "agent-x",
  // NOTE: no sessionId — the point of this suite is the default.
};

describe("MemoryCore Gateway write client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_WRITE_TOKEN;
  });

  it("captures L0 with a non-empty session_id even when no session is configured (gateway rejects empty)", async () => {
    process.env.TEST_WRITE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 0, data: { accepted_ids: ["msg-1"] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await captureConversation(baseCfg, { messages: [{ role: "user", content: "hello" }] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.session_id).toBe("default"); // not "" — the gateway 400s on empty
    expect(body.team_id).toBe("team-x");
    expect(body.user_id).toBe("user-x");
    expect(body.agent_id).toBe("agent-x");
    expect(body.messages).toHaveLength(1);
  });

  it("prefers an explicit sessionId argument over the default", async () => {
    process.env.TEST_WRITE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await captureConversation(baseCfg, { messages: [], sessionId: "sess-explicit" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.session_id).toBe("sess-explicit");
  });

  it("upserts a L1 atom by id with the write header set", async () => {
    process.env.TEST_WRITE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0, data: { version: "v2" } }));
    vi.stubGlobal("fetch", fetchMock);

    await updateAtomicMemory(baseCfg, { id: "atom-1", content: "remember this", background: "ctx" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url).endsWith("/v3/atomic/update")).toBe(true);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-mem-test-fixture");
    const body = JSON.parse(init.body as string);
    expect(body.id).toBe("atom-1");
    expect(body.content).toBe("remember this");
  });

  it("captureTurn commits a turn to /capture (v1, raw body) and returns the pipeline-notify result", async () => {
    process.env.TEST_WRITE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ l0_recorded: 2, scheduler_notified: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await captureTurn(baseCfg, {
      userContent: "hello",
      assistantContent: "hi there",
      sessionKey: "sess-turn",
    });

    expect(res.l0Recorded).toBe(2);
    expect(res.schedulerNotified).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url).endsWith("/capture")).toBe(true);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-mem-test-fixture");
    const body = JSON.parse(init.body as string);
    expect(body.user_content).toBe("hello");
    expect(body.assistant_content).toBe("hi there");
    expect(body.session_key).toBe("sess-turn");
    // /capture is NOT the /v3 envelope — captureTurn unwraps the raw body itself.
  });

  it("captureTurn falls back to the configured session id when no sessionKey given", async () => {
    process.env.TEST_WRITE_TOKEN = "sk-mem-test-fixture";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ l0_recorded: 1, scheduler_notified: false }));
    vi.stubGlobal("fetch", fetchMock);

    const cfgWithSession = { ...baseCfg, sessionId: "cfg-session" };
    await captureTurn(cfgWithSession, { userContent: "a", assistantContent: "b" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.session_key).toBe("cfg-session");
  });
});
