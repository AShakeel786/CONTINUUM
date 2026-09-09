import { describe, expect, it, vi } from "vitest";
import { makeEnsureCompatProxy, type HealthProbe, type SpawnState } from "../deepseek-compat-proxy.js";
import type { CompatProxySpec } from "../types.js";
import { DEEPSEEK_PROXY_SERVICE_ID } from "../deepseek-proxy.js";

const SPEC: CompatProxySpec = {
  host: "127.0.0.1",
  port: 8177,
  cliPathSuffix: "/anthropic",
  upstreamBaseUrl: "https://api.deepseek.com",
  healthPath: "/health",
  scriptPath: "providers/deepseek-proxy-bin.js",
  serviceId: DEEPSEEK_PROXY_SERVICE_ID,
};

const HEALTHY: HealthProbe = { ok: true, serviceId: DEEPSEEK_PROXY_SERVICE_ID, upstream: "https://api.deepseek.com" };

interface Harness {
  ensure: (spec: CompatProxySpec, onProgress?: (line: string) => void) => Promise<{ ready: boolean; kind?: "reuse" | "spawned"; detail?: string }>;
  healthCheck: ReturnType<typeof vi.fn>;
  spawnProxy: ReturnType<typeof vi.fn>;
  resolveScriptPath: ReturnType<typeof vi.fn>;
}

function makeHarness(healthProbes: HealthProbe[], spawnBehavior?: (state: SpawnState) => void): Harness {
  const healthCheck = vi.fn(async () => healthProbes.length > 0 ? healthProbes.shift()! : ({ ok: false } as HealthProbe));
  const spawnProxy = vi.fn((_command: string, _args: readonly string[], state: SpawnState) => {
    spawnBehavior?.(state);
  });
  const resolveScriptPath = vi.fn(() => "C:/continuum/dist/providers/deepseek-proxy-bin.js");
  const ensure = makeEnsureCompatProxy({
    healthCheck,
    spawnProxy,
    resolveScriptPath,
    sleep: () => Promise.resolve(),
    pollIntervalMs: 1,
    startWaitMs: 50,
    healthTimeoutMs: 500,
  });
  return { ensure, healthCheck, spawnProxy, resolveScriptPath };
}

describe("makeEnsureCompatProxy", () => {
  it("reuses an already-healthy proxy without spawning", async () => {
    const h = makeHarness([HEALTHY]);
    const result = await h.ensure(SPEC);
    expect(result).toEqual({ ready: true, kind: "reuse" });
    expect(h.healthCheck).toHaveBeenCalledTimes(1);
    expect(h.healthCheck).toHaveBeenCalledWith("http://127.0.0.1:8177/health", 500);
    expect(h.spawnProxy).not.toHaveBeenCalled();
  });

  it("never duplicates: repeated ensure calls on a healthy proxy never spawn", async () => {
    const h = makeHarness([HEALTHY, HEALTHY]);
    await h.ensure(SPEC);
    const second = await h.ensure(SPEC);
    expect(second).toEqual({ ready: true, kind: "reuse" });
    expect(h.spawnProxy).not.toHaveBeenCalled();
  });

  it("starts the proxy when no healthy instance exists and waits for health", async () => {
    const h = makeHarness([{ ok: false }, HEALTHY]);
    const result = await h.ensure(SPEC);
    expect(result).toEqual({ ready: true, kind: "spawned" });
    expect(h.spawnProxy).toHaveBeenCalledTimes(1);
    // Spawn args are the proxy script + port + upstream ONLY — no secrets,
    // no env, no credentials ever enter the child's command line.
    expect(h.spawnProxy.mock.calls[0]![0]).toBe(process.execPath);
    expect(h.spawnProxy.mock.calls[0]![1]).toEqual([
      "C:/continuum/dist/providers/deepseek-proxy-bin.js",
      "--port",
      "8177",
      "--upstream",
      "https://api.deepseek.com",
    ]);
    expect(JSON.stringify(h.spawnProxy.mock.calls[0]![1])).not.toMatch(/sk-|token|secret/i);
  });

  it("refuses a foreign listener squatting the port (health answers but not our service)", async () => {
    const h = makeHarness([{ ok: true, serviceId: "some-other-service", upstream: "https://api.deepseek.com" }]);
    const result = await h.ensure(SPEC);
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("refusing");
    expect(h.spawnProxy).not.toHaveBeenCalled();
  });

  it("refuses a same-service proxy whose upstream does not match the declared one", async () => {
    const h = makeHarness([{ ok: true, serviceId: DEEPSEEK_PROXY_SERVICE_ID, upstream: "http://127.0.0.1:8096" }]);
    const result = await h.ensure(SPEC);
    expect(result.ready).toBe(false);
    expect(h.spawnProxy).not.toHaveBeenCalled();
  });

  it("reports a clear failure when the proxy process cannot be spawned", async () => {
    const h = makeHarness([{ ok: false }], (state) => {
      state.error = "ENOENT: script not found";
    });
    const result = await h.ensure(SPEC);
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("could not start");
    expect(result.detail).toContain("ENOENT");
  });

  it("reports a clear failure when the proxy exits immediately (port conflict)", async () => {
    const h = makeHarness([{ ok: false }], (state) => {
      state.exitCode = 1;
    });
    const result = await h.ensure(SPEC);
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("exited immediately");
  });

  it("reports a clear failure when health is never reached within the window", async () => {
    const h = makeHarness([{ ok: false }]);
    const result = await h.ensure(SPEC);
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("did not become healthy");
    expect(h.spawnProxy).toHaveBeenCalledTimes(1);
  });

  it("reports progress lines without any credential material", async () => {
    const lines: string[] = [];
    const h = makeHarness([HEALTHY]);
    await h.ensure(SPEC, (line) => lines.push(line));
    expect(lines.join("\n")).not.toMatch(/sk-|token|secret/i);
  });
});
