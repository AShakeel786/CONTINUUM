import { describe, expect, it, vi } from "vitest";
import { CredentialManager } from "../../auth/credential-manager.js";
import { FakeBackend } from "../../auth/__tests__/fake-backend.js";
import { DEFAULT_OPTIONS } from "../../health/adapters.js";
import { fetchStableFromMemoryCore } from "../memorycore-client.js";
import {
  MEMORY_CORE_DEFAULT_URL,
  MEMORY_CORE_SERVICE_TOKEN_ENV,
  memoryCoreBaseUrl,
  resolveMemoryCoreConfig,
  storeMemoryCoreServiceToken,
} from "../memorycore-config.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("MemoryCore unified config resolution", () => {
  it("returns an actionable reason when no token is available", async () => {
    const res = await resolveMemoryCoreConfig({ env: {}, credentialManager: undefined });
    expect(res.config).toBeUndefined();
    expect(res.reason).toContain("continuum setup --memory");
    expect(res.reason).toContain(MEMORY_CORE_SERVICE_TOKEN_ENV);
  });

  it("defaults the endpoint to the local gateway (no env override)", async () => {
    expect(memoryCoreBaseUrl({})).toBe(MEMORY_CORE_DEFAULT_URL);
    // doctor's DEFAULT_OPTIONS shares the same default — the consistency contract.
    expect(DEFAULT_OPTIONS.memoryCoreUrl).toBe(MEMORY_CORE_DEFAULT_URL);
  });

  it("resolves an env-var token with URL + identity overrides", async () => {
    const res = await resolveMemoryCoreConfig({
      env: {
        [MEMORY_CORE_SERVICE_TOKEN_ENV]: "sk-env-token",
        CONTINUUM_MEMORY_CORE_URL: "http://gateway:9999",
        CONTINUUM_MEMORY_CORE_TEAM_ID: "team-x",
        CONTINUUM_MEMORY_CORE_USER_ID: "user-x",
        CONTINUUM_MEMORY_CORE_AGENT_ID: "agent-x",
      },
    });
    expect(res.config).toBeDefined();
    expect(res.config!.baseUrl).toBe("http://gateway:9999");
    expect(res.config!.serviceToken.envVar).toBe(MEMORY_CORE_SERVICE_TOKEN_ENV);
    expect(res.config!.teamId).toBe("team-x");
    expect(res.config!.userId).toBe("user-x");
    expect(res.config!.agentId).toBe("agent-x");
    // resolveToken closure resolves the env shape to the value.
    expect(await res.config!.resolveToken!(res.config!.serviceToken)).toBe("sk-env-token");
  });

  it("resolves a credential-backed token from the secure store (never duplicated)", async () => {
    const cm = new CredentialManager(new FakeBackend());
    const ref = await storeMemoryCoreServiceToken(cm, "sk-credential-token");
    expect(ref).toBe("credential://memorycore/service-token");

    const res = await resolveMemoryCoreConfig({ credentialManager: cm, env: {} });
    expect(res.config).toBeDefined();
    expect(res.config!.baseUrl).toBe(MEMORY_CORE_DEFAULT_URL);
    expect(res.config!.serviceToken.credentialUri).toBe("credential://memorycore/service-token");
    // The value resolves only through the credential store at call time.
    expect(await res.config!.resolveToken!(res.config!.serviceToken)).toBe("sk-credential-token");
  });

  it("prefers an explicit env token over a stored credential", async () => {
    const cm = new CredentialManager(new FakeBackend());
    await storeMemoryCoreServiceToken(cm, "sk-credential-token");
    const res = await resolveMemoryCoreConfig({
      credentialManager: cm,
      env: { [MEMORY_CORE_SERVICE_TOKEN_ENV]: "sk-env-token" },
    });
    expect(res.config!.serviceToken.envVar).toBe(MEMORY_CORE_SERVICE_TOKEN_ENV);
  });

  it("configured credential token flows into the gateway Authorization header (end-to-end)", async () => {
    const cm = new CredentialManager(new FakeBackend());
    await storeMemoryCoreServiceToken(cm, "sk-credential-token");
    const res = await resolveMemoryCoreConfig({ credentialManager: cm, env: {} });

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v3/core/read")) return jsonResponse({ code: 0, data: { content: "persona" } });
      if (u.endsWith("/v3/scenario/ls")) return jsonResponse({ code: 0, data: { entries: [] } });
      throw new Error(`unexpected URL: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const stable = await fetchStableFromMemoryCore(res.config!);
      expect(stable.persona?.content).toBe("persona");
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-credential-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
