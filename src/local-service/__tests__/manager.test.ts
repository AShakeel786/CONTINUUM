import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalServiceManager, LocalServicePortConflictError, LocalServiceStartupError } from "../manager.js";
import { stateFilePath } from "../state.js";
import type { LocalServiceDescriptor } from "../types.js";
import type { FetchLike } from "../health.js";

function seedState(dataDir: string, pid: number): void {
  const file = stateFilePath(dataDir, "local-test");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1, providerId: "local-test", pid, host: "127.0.0.1", port: 8080,
      healthPath: "/v1/models", command: "/opt/venv/bin/python", args: ["-m", "mlx_lm"],
      startedAt: new Date().toISOString(), logFile: join(dataDir, "x.log"), ownedByContinuum: true,
    }),
  );
}

const descriptor: LocalServiceDescriptor = {
  providerId: "local-test",
  command: "/opt/venv/bin/python",
  args: ["-m", "mlx_lm", "server", "--model", "/models/foo", "--host", "127.0.0.1", "--port", "8080"],
  host: "127.0.0.1",
  port: 8080,
  healthPath: "/v1/models",
  startupTimeoutSec: 30,
  model: "/models/foo",
};

/** A fake fetch whose response is controlled per-test. */
function fakeFetch(mode: "down" | "healthy-compatible" | "healthy-incompatible" | "reachable-4xx"): FetchLike {
  return async () => {
    if (mode === "down") throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (mode === "reachable-4xx") return { ok: false, status: 404, text: async () => "not found" };
    if (mode === "healthy-incompatible") return { ok: true, status: 200, text: async () => "<html>hi</html>" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ object: "list", data: [{ id: "m" }] }) };
  };
}

interface FakeChild {
  pid: number | undefined;
  killed: string[];
  exit(): void;
  kill(sig?: string): void;
  on(ev: "exit", cb: () => void): void;
  unref(): void;
}
function makeFakeChild(pid: number | undefined): FakeChild {
  let exitCb: (() => void) | undefined;
  return {
    pid,
    killed: [],
    exit() { exitCb?.(); },
    kill(sig = "SIGTERM") { this.killed.push(sig); },
    on(_ev, cb) { exitCb = cb; },
    unref() {},
  };
}

describe("LocalServiceManager lifecycle", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cont-ls-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reuses a healthy CONTINUUM-owned process without spawning", async () => {
    seedState(dataDir, process.pid);
    const spawn = vi.fn();
    const mgr = new LocalServiceManager({ dataDir, fetchImpl: fakeFetch("healthy-compatible"), spawn });
    const outcome = await mgr.ensureRunning(descriptor);
    expect(outcome.kind).toBe("reused-owned");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reuses a healthy compatible foreign endpoint without claiming ownership", async () => {
    const spawn = vi.fn();
    const mgr = new LocalServiceManager({ dataDir, fetchImpl: fakeFetch("healthy-compatible"), spawn });
    const outcome = await mgr.ensureRunning(descriptor);
    expect(outcome).toEqual({ kind: "reused-foreign", host: "127.0.0.1", port: 8080 });
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(stateFilePath(dataDir, "local-test"))).toBe(false);
  });

  it("refuses to touch a foreign process that is not an OpenAI-compatible endpoint", async () => {
    const spawn = vi.fn();
    const mgr = new LocalServiceManager({ dataDir, fetchImpl: fakeFetch("healthy-incompatible"), spawn });
    await expect(mgr.ensureRunning(descriptor)).rejects.toBeInstanceOf(LocalServicePortConflictError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("recovers from stale state (dead pid) then starts a fresh server", async () => {
    seedState(dataDir, 2147480000);
    // fetch: down on the first probes, healthy once "started".
    let started = false;
    const fetchImpl: FetchLike = async () => {
      if (!started) throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { ok: true, status: 200, text: async () => JSON.stringify({ object: "list", data: [] }) };
    };
    const child = makeFakeChild(999001);
    const spawn = vi.fn(() => { started = true; return child; });
    const mgr = new LocalServiceManager({ dataDir, fetchImpl, spawn, sleep: async () => {} });
    const outcome = await mgr.ensureRunning(descriptor);
    expect(outcome.kind).toBe("started");
    expect(spawn).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(readFileSync(stateFilePath(dataDir, "local-test"), "utf8"));
    expect(persisted.pid).toBe(999001);
    expect(persisted.ownedByContinuum).toBe(true);
  });

  it("dedupes concurrent startup attempts into a single spawn", async () => {
    let started = false;
    const fetchImpl: FetchLike = async () => {
      if (!started) throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    };
    const spawn = vi.fn(() => { started = true; return makeFakeChild(999002); });
    const mgr = new LocalServiceManager({ dataDir, fetchImpl, spawn, sleep: async () => {} });
    const [a, b, c] = await Promise.all([
      mgr.ensureRunning(descriptor),
      mgr.ensureRunning(descriptor),
      mgr.ensureRunning(descriptor),
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect([a.kind, b.kind, c.kind]).toEqual(["started", "started", "started"]);
  });

  it("times out with a clear error (and kills its own child) when the server never becomes healthy", async () => {
    let clock = 0;
    const child = makeFakeChild(999003);
    const spawn = vi.fn(() => child);
    const mgr = new LocalServiceManager({
      dataDir,
      fetchImpl: fakeFetch("down"),
      spawn,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    await expect(mgr.ensureRunning({ ...descriptor, startupTimeoutSec: 5 })).rejects.toBeInstanceOf(LocalServiceStartupError);
    expect(child.killed).toContain("SIGTERM");
    expect(existsSync(stateFilePath(dataDir, "local-test"))).toBe(false);
  });

  it("stop() never signals a foreign process on the port", async () => {
    const killSpy = vi.spyOn(process, "kill");
    try {
      const mgr = new LocalServiceManager({ dataDir, fetchImpl: fakeFetch("healthy-compatible") });
      const res = await mgr.stop(descriptor);
      expect(res.result).toBe("not-owned");
      // process.kill may be called with signal 0 for liveness on OUR pids, but
      // never a terminating signal here (there is no owned state file).
      for (const call of killSpy.mock.calls) expect(call[1]).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("status() distinguishes owned / foreign / stopped", async () => {
    const stopped = new LocalServiceManager({ dataDir, fetchImpl: fakeFetch("down") });
    expect((await stopped.status(descriptor)).state).toBe("stopped");

    const foreign = new LocalServiceManager({ dataDir, fetchImpl: fakeFetch("healthy-compatible") });
    expect((await foreign.status(descriptor)).state).toBe("running-foreign");

    seedState(dataDir, process.pid);
    const owned = new LocalServiceManager({ dataDir, fetchImpl: fakeFetch("healthy-compatible") });
    const s = await owned.status(descriptor);
    expect(s.state).toBe("running-owned");
    expect(s.pid).toBe(process.pid);
  });
});
