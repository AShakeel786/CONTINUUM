/**
 * Local-dependency readiness gate tests (health/launch-guard.ts) — the fix
 * for the reported "ConnectionRefused / retry-loop" bug: a proxy-routed
 * launch (DeepSeek via the Tencent MemoryProxy) must never spawn the
 * provider CLI straight into a dead local proxy. Reuses the existing
 * HealthDoctor (checks.ts + repair.ts + state.ts) — no second recovery path.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthOptions, HealthRuntime, RecoveryPolicy } from "../types.js";
import { makeEnsureProxyReady } from "../launch-guard.js";

interface CmdResult {
  code: number | null;
  stdout?: string;
  stderr?: string;
}

class FakeRuntime implements HealthRuntime {
  nowMs = 1_000_000;
  now = () => this.nowMs;
  calls: { cmd: string; args: readonly string[] }[] = [];
  private cmdHandlers = new Map<string, (args: readonly string[]) => CmdResult>();
  private fetchResults = new Map<string, { ok: boolean; status: number; body?: string }>();

  on(cmd: string, fn: (args: readonly string[]) => CmdResult): this {
    this.cmdHandlers.set(cmd, fn);
    return this;
  }
  onFetch(url: string, result: { ok: boolean; status: number; body?: string }): this {
    this.fetchResults.set(url, result);
    return this;
  }
  async run(cmd: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    this.calls.push({ cmd, args });
    const h = this.cmdHandlers.get(cmd);
    if (!h) return { code: 0, stdout: "", stderr: "" };
    const r = h(args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  /** Detached GUI launch (Windows Docker Desktop.exe). */
  async start(cmd: string, args: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({ cmd, args });
    return { ok: true };
  }
  async fetch(url: string): Promise<{ ok: boolean; status: number; body?: string }> {
    return this.fetchResults.get(url) ?? { ok: false, status: 0 };
  }
  async sleep(ms: number): Promise<void> {
    this.nowMs += ms;
  }
}

function tmpStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "launch-guard-")), "health-state.json");
}

function makeOptions(overrides?: Partial<HealthOptions>): HealthOptions {
  return {
    tencentMacDir: "/tmp/fake-tencent/mac",
    memoryCoreUrl: "http://127.0.0.1:8420",
    tencentConfigured: true,
    proxyHealthUrl: "http://127.0.0.1:8096/health",
    containers: { memoryCore: "tdai-memory-core", proxy: "tdai-proxy", hub: "tdai-memory-hub" },
    pinnedImage: "agentmemory/memory-core:phase13",
    stateFile: tmpStateFile(),
    providerExecutables: ["claude"],
    ...overrides,
  };
}

const POLICY: RecoveryPolicy = { cooldownMs: 30_000, breakerFailureThreshold: 3, breakerOpenMs: 5 * 60_000 };

function healthyDocker(runtime: FakeRuntime): FakeRuntime {
  return runtime.on("docker", (args) => {
    if (args[0] === "info") return { code: 0 };
    if (args[0] === "inspect") return { code: 0, stdout: "healthy" };
    if (args[0] === "ps") {
      return {
        code: 0,
        stdout: [
          "tdai-memory-core\tUp 3 minutes (healthy)\tagentmemory/memory-core:phase13",
          "tdai-proxy\tUp 3 minutes (healthy)\tagentmemory/memory-proxy:latest",
          "tdai-memory-hub\tUp 3 minutes (healthy)\tagentmemory/memory-hub:latest",
        ].join("\n"),
      };
    }
    return { code: 0 };
  });
}

describe("ensureProxyReady — fast path (already healthy)", () => {
  it("returns ready with no repair when the proxy /health probe succeeds, and never shells out to docker", async () => {
    const runtime = new FakeRuntime();
    runtime.onFetch("http://127.0.0.1:8096/health", { ok: true, status: 200 });
    const ensureProxyReady = makeEnsureProxyReady({ runtime, options: makeOptions(), policy: POLICY });

    const progress: string[] = [];
    const result = await ensureProxyReady("http://127.0.0.1:8096", (line) => progress.push(line));

    expect(result.ready).toBe(true);
    expect(result.repairAttempted).toBe(false);
    expect(runtime.calls).toEqual([]); // no docker calls at all — single HTTP probe only
    expect(progress).toEqual([]); // no progress noise when nothing was wrong
  });
});

describe("ensureProxyReady — self-heal", () => {
  it("detects a stopped proxy container, restarts it via the existing repair path, waits for real health, and becomes ready", async () => {
    const runtime = healthyDocker(new FakeRuntime());
    // Proxy container reported stopped; everything else healthy.
    runtime.on("docker", (args) => {
      if (args[0] === "info") return { code: 0 };
      if (args[0] === "inspect") return { code: 0, stdout: "healthy" };
      if (args[0] === "ps") {
        return {
          code: 0,
          stdout: [
            "tdai-memory-core\tUp 3 minutes (healthy)\tagentmemory/memory-core:phase13",
            "tdai-proxy\tExited (1) 2 minutes ago\tagentmemory/memory-proxy:latest",
            "tdai-memory-hub\tUp 3 minutes (healthy)\tagentmemory/memory-hub:latest",
          ].join("\n"),
        };
      }
      if (args[0] === "start" && args[1] === "tdai-proxy") return { code: 0 };
      return { code: 0 };
    });
    // First health probe (fast path) fails; after `docker start`, the second
    // probe (inside repair's re-diagnose) succeeds.
    let proxyProbes = 0;
    runtime.onFetch("http://127.0.0.1:8420/health", { ok: true, status: 200 });
    runtime.onFetch("http://127.0.0.1:8420/v3/meta/auth/verify", { ok: true, status: 200, body: "{}" });
    const origFetch = runtime.fetch.bind(runtime);
    runtime.fetch = async (url: string) => {
      if (url === "http://127.0.0.1:8096/health") {
        proxyProbes += 1;
        return proxyProbes === 1 ? { ok: false, status: 0 } : { ok: true, status: 200 };
      }
      if (url.includes("/proxy/default/v1/chat/completions")) return { ok: false, status: 401, body: "invalid user_key" };
      return origFetch(url);
    };

    const ensureProxyReady = makeEnsureProxyReady({ runtime, options: makeOptions(), policy: POLICY });
    const progress: string[] = [];
    const result = await ensureProxyReady("http://127.0.0.1:8096", (line) => progress.push(line));

    expect(result.ready).toBe(true);
    expect(result.repairAttempted).toBe(true);
    const start = runtime.calls.find((c) => c.cmd === "docker" && c.args[0] === "start");
    expect(start?.args).toEqual(["start", "tdai-proxy"]);
    // Never touches memory-core or hub — only the container the check actually flagged.
    expect(runtime.calls.some((c) => c.cmd === "docker" && c.args[0] === "start" && c.args[1] !== "tdai-proxy")).toBe(false);
    expect(progress.some((l) => l.includes("checking service"))).toBe(true);
    expect(progress.some((l) => l.includes("restarted"))).toBe(true);
    expect(progress.some((l) => l.includes("Recovered in"))).toBe(true);
  });

  it("reports not-ready, with a safe detail and no secrets, when repair cannot bring the proxy up", async () => {
    const runtime = new FakeRuntime();
    runtime.onFetch("http://127.0.0.1:8096/health", { ok: false, status: 0 });
    // Docker itself unreachable — repair can't do anything but report it.
    runtime.on("docker", () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" }));

    const ensureProxyReady = makeEnsureProxyReady({ runtime, options: makeOptions(), policy: POLICY });
    const result = await ensureProxyReady("http://127.0.0.1:8096");

    expect(result.ready).toBe(false);
    expect(result.repairAttempted).toBe(true);
    expect(result.detail).not.toMatch(/sk-|api[_-]?key|token|secret|bearer/i);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("reports not-ready (never a false 'ready') when the Tencent stack was never deployed at all — not merely down", async () => {
    // Regression: `runHealthChecks` marks every Tencent check "skipped" (not
    // "down") when the stack isn't configured/deployed, since it's an
    // OPTIONAL feature for the general health dashboard — but a proxy-routed
    // launch has no such option. Reproduces this machine's actual state
    // (verified live: no CONTINUUM_MEMORY_CORE_URL, no tdai-* containers,
    // docker daemon unreachable) where an earlier version of this gate
    // misread "skipped" as "healthy" and would have let the launch through.
    const runtime = new FakeRuntime();
    runtime.onFetch("http://127.0.0.1:8096/health", { ok: false, status: 0 });
    runtime.on("docker", () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" }));
    const options = makeOptions({ tencentConfigured: false }); // matches "never deployed", not "temporarily down"

    // Hermetic: no Docker Desktop installed — otherwise the discovery fallback
    // would read a Windows test host's Docker install as a deployed stack and
    // arm the docker-desktop repair, breaking this test's "never deployed" premise.
    const ensureProxyReady = makeEnsureProxyReady({ runtime, options, policy: POLICY, discoverDockerDesktop: async () => undefined });
    const result = await ensureProxyReady("http://127.0.0.1:8096");

    expect(result.ready).toBe(false);
  });

  it("is bounded: a second call right after a failed repair is cooldown-gated, not re-hammering docker", async () => {
    // One shared runtime/clock (a fresh FakeRuntime per call would reset the
    // fake clock to its own epoch, which would make "elapsed since last
    // attempt" meaningless — real wall-clock time only moves forward).
    // Container entirely MISSING (not just stopped) → "container-recreate",
    // which aborts immediately on the unreadable canonical .env (fake
    // tencentMacDir) with no internal wait-loop — so the clock genuinely
    // stays within the 30s cooldown window between the two calls below.
    const runtime = healthyDocker(new FakeRuntime());
    runtime.onFetch("http://127.0.0.1:8096/health", { ok: false, status: 0 });
    // MemoryCore reported healthy so its own (unrelated) repair path never
    // fires here — this test isolates the proxy-container-missing path only.
    runtime.onFetch("http://127.0.0.1:8420/health", { ok: true, status: 200 });
    runtime.onFetch("http://127.0.0.1:8420/v3/meta/auth/verify", { ok: true, status: 200, body: "{}" });
    runtime.on("docker", (args) => {
      if (args[0] === "info") return { code: 0 };
      if (args[0] === "ps") {
        return {
          code: 0,
          stdout: [
            "tdai-memory-core\tUp 3 minutes (healthy)\tagentmemory/memory-core:phase13",
            "tdai-memory-hub\tUp 3 minutes (healthy)\tagentmemory/memory-hub:latest",
          ].join("\n"), // tdai-proxy absent entirely
        };
      }
      return { code: 0 };
    });
    const options = makeOptions(); // shared stateFile — cooldown/breaker persist across calls
    const ensureProxyReady = makeEnsureProxyReady({ runtime, options, policy: POLICY });

    const firstResult = await ensureProxyReady("http://127.0.0.1:8096");
    expect(firstResult.ready).toBe(false);
    expect(runtime.nowMs).toBe(1_000_000); // no wait-loop ran — the abort was immediate

    runtime.calls = [];
    const secondResult = await ensureProxyReady("http://127.0.0.1:8096");
    expect(secondResult.ready).toBe(false);
    // Cooldown (30s, clock hasn't moved) skips the repair attempt entirely on
    // the second call — no `bash start-tencent.sh` recreate issued again.
    expect(runtime.calls.some((c) => c.cmd === "bash")).toBe(false);
  });
});
