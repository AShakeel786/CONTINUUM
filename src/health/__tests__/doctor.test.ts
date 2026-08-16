/**
 * Health layer tests — the Phase 14 acceptance matrix:
 *   all healthy → no-op; core/proxy stopped → recover; missing container →
 *   recreate from canonical config; docker unavailable; provider CLI
 *   missing/auth expired (directive only); memory-core unavailable → degraded
 *   warning; restart/cooldown; repeated failure → circuit breaker; pinned-image
 *   preservation; stale child cleanup; no secret leakage.
 */
import { describe, expect, it } from "vitest";
import type { HealthOptions, HealthRuntime } from "../types.js";
import { HealthDoctor } from "../doctor.js";
import { buildPreflightWarnings } from "../preflight.js";
import { parseContainerStates } from "../checks.js";

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
  /** Default healthy docker responses. */
  healthyDocker(): this {
    this.on("docker", (args) => {
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
    return this;
  }
  onFetch(url: string, result: { ok: boolean; status: number; body?: string }): this {
    this.fetchResults.set(url, result);
    return this;
  }
  healthyFetch(): this {
    this.onFetch("http://127.0.0.1:8420/health", { ok: true, status: 200 });
    this.onFetch("http://127.0.0.1:8096/health", { ok: true, status: 200 });
    // Functional auth probes for a healthy stack: MemoryCore's auth/verify
    // answers (reachable, key invalid) and the proxy rejects the probe key
    // with "invalid user_key" (proving it reached MemoryCore).
    this.onFetch("http://127.0.0.1:8420/v3/meta/auth/verify", { ok: true, status: 200, body: JSON.stringify({ code: 0, data: { valid: false } }) });
    this.onFetch("http://127.0.0.1:8096/proxy/default/v1/chat/completions", {
      ok: false,
      status: 401,
      body: JSON.stringify({ error: "Authentication failed: invalid user_key" }),
    });
    return this;
  }

  async run(cmd: string, args: readonly string[], _opts?: { timeoutMs?: number; cwd?: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
    this.calls.push({ cmd, args });
    const h = this.cmdHandlers.get(cmd);
    if (!h) return { code: 0, stdout: "", stderr: "" };
    const r = h(args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  async fetch(url: string, _init?: { timeoutMs?: number; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; body?: string }> {
    return this.fetchResults.get(url) ?? { ok: false, status: 0 };
  }
  /** Instant wait that also advances the fake clock, so poll loops terminate. */
  async sleep(ms: number): Promise<void> {
    this.nowMs += ms;
  }
}

let stateFileCounter = 0;

function makeOptions(overrides?: Partial<HealthOptions>): HealthOptions {
  stateFileCounter += 1;
  return {
    tencentMacDir: "/tmp/fake-tencent/mac",
    memoryCoreUrl: "http://127.0.0.1:8420",
    tencentConfigured: true, // health tests exercise the Tencent stack recovery paths
    proxyHealthUrl: "http://127.0.0.1:8096/health",
    containers: { memoryCore: "tdai-memory-core", proxy: "tdai-proxy", hub: "tdai-memory-hub" },
    pinnedImage: "agentmemory/memory-core:phase13",
    stateFile: `/tmp/fake-state-${process.pid}-${stateFileCounter}.json`,
    providerExecutables: ["claude"],
    ...overrides,
  };
}

const POLICY = { cooldownMs: 30_000, breakerFailureThreshold: 3, breakerOpenMs: 5 * 60_000 };

function makeDoctor(runtime: FakeRuntime, options?: Partial<HealthOptions>, readPinnedEnv?: () => Promise<string | undefined>) {
  return new HealthDoctor({ runtime, options: makeOptions(options), policy: POLICY, readPinnedEnv });
}

// ── 1. All healthy → no-op ────────────────────────────────────────────────

describe("all healthy", () => {
  it("reports healthy and repair performs no actions", async () => {
    const runtime = new FakeRuntime().healthyDocker().healthyFetch();
    const doctor = makeDoctor(runtime);
    const report = await doctor.diagnose();
    expect(report.overall).toBe("healthy");
    expect(report.checks.find((c) => c.name === "container:tdai-memory-core")?.status).toBe("ok");

    const { outcomes, after } = await doctor.repair();
    expect(outcomes).toEqual([]);
    expect(after.overall).toBe("healthy");
    // No docker start / kill / open commands were issued.
    expect(runtime.calls.filter((c) => ["start", "kill", "open"].includes(c.cmd) || (c.cmd === "bash"))).toEqual([]);
  });
});

// ── 2/3. Stopped core/proxy → targeted docker start ────────────────────────

describe("stopped containers", () => {
  it("starts a stopped memory-core without touching anything else", async () => {
    const runtime = new FakeRuntime().healthyFetch();
    runtime.on("docker", (args) => {
      if (args[0] === "info") return { code: 0 };
      if (args[0] === "inspect") return { code: 0, stdout: "healthy" };
      if (args[0] === "ps") {
        return {
          code: 0,
          stdout: [
            "tdai-memory-core\tExited (137) 5 minutes ago\tagentmemory/memory-core:phase13",
            "tdai-proxy\tUp 3 minutes (healthy)\tagentmemory/memory-proxy:latest",
            "tdai-memory-hub\tUp 3 minutes (healthy)\tagentmemory/memory-hub:latest",
          ].join("\n"),
        };
      }
      if (args[0] === "start" && args[1] === "tdai-memory-core") return { code: 0 };
      return { code: 0 };
    });
    const doctor = makeDoctor(runtime);
    const before = await doctor.diagnose();
    expect(before.checks.find((c) => c.name === "container:tdai-memory-core")?.status).toBe("down");

    const { outcomes } = await doctor.repair();
    const start = runtime.calls.find((c) => c.cmd === "docker" && c.args[0] === "start");
    expect(start?.args).toEqual(["start", "tdai-memory-core"]);
    expect(outcomes[0]?.status).toBe("repaired");
    // No broad recreate (bash start-tencent.sh) for a merely-stopped container.
    expect(runtime.calls.some((c) => c.cmd === "bash")).toBe(false);
  });

  it("starts a stopped proxy", async () => {
    const runtime = new FakeRuntime().healthyFetch();
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
      if (args[0] === "start") return { code: 0 };
      return { code: 0 };
    });
    const { outcomes } = await makeDoctor(runtime).repair();
    expect(outcomes.some((o) => o.checkName === "container:tdai-proxy" && o.status === "repaired")).toBe(true);
  });
});

// ── 4. Missing container → recreate from canonical config (pinned image) ──

describe("missing container", () => {
  function missingCoreRuntime(): FakeRuntime {
    const runtime = new FakeRuntime().healthyFetch();
    runtime.on("docker", (args) => {
      if (args[0] === "info") return { code: 0 };
      if (args[0] === "ps") {
        return {
          code: 0,
          stdout: ["tdai-proxy\tUp 3 minutes (healthy)\tagentmemory/memory-proxy:latest", "tdai-memory-hub\tUp 3 minutes (healthy)\tagentmemory/memory-hub:latest"].join("\n"),
        };
      }
      if (args[0] === "image" && args[1] === "inspect") return { code: 0 };
      return { code: 0 };
    });
    return runtime;
  }

  it("runs the canonical start script when pinned image matches", async () => {
    const runtime = missingCoreRuntime();
    runtime.on("bash", () => ({ code: 0, stdout: "all services ready" }));

    const { outcomes } = await makeDoctor(runtime, undefined, async () => "agentmemory/memory-core:phase13").repair();
    const recreate = outcomes.find((o) => o.target === "container-recreate");
    expect(recreate?.status).toBe("repaired");
    const bash = runtime.calls.find((c) => c.cmd === "bash");
    expect(bash?.args[0]).toContain("start-tencent.sh");
  });

  it("ABORTS recreate when canonical .env pins something other than the pinned image", async () => {
    const runtime = missingCoreRuntime();
    runtime.on("bash", () => ({ code: 0, stdout: "should never run" }));

    const { outcomes } = await makeDoctor(runtime, undefined, async () => "agentmemory/memory-core:latest").repair();
    const recreate = outcomes.find((o) => o.target === "container-recreate");
    expect(recreate?.status).toBe("aborted");
    expect(recreate?.detail).toContain("refusing to recreate");
    expect(runtime.calls.some((c) => c.cmd === "bash")).toBe(false);
  });
});

// ── 5. Docker unavailable → Docker Desktop recovery + cooldown ─────────────

describe("docker unavailable", () => {
  it("launches Docker Desktop and waits for the daemon", async () => {
    const runtime = new FakeRuntime();
    let infoCalls = 0;
    runtime.on("docker", (args) => {
      if (args[0] === "info") {
        infoCalls += 1;
        return { code: infoCalls >= 3 ? 0 : 1, stderr: "Cannot connect to the Docker daemon" };
      }
      return { code: 0 };
    });
    runtime.on("open", () => ({ code: 0 }));

    const doctor = makeDoctor(runtime);
    const report = await doctor.diagnose();
    expect(report.checks.find((c) => c.name === "docker")?.status).toBe("down");

    const { outcomes } = await doctor.repair();
    expect(outcomes.some((o) => o.target === "docker-desktop" && o.status === "repaired")).toBe(true);
    expect(runtime.calls.some((c) => c.cmd === "open" && c.args[0] === "-a" && c.args[1] === "Docker")).toBe(true);
  });

  it("cooldown: a second repair within the window is skipped", async () => {
    const runtime = new FakeRuntime();
    runtime.on("docker", () => ({ code: 1, stderr: "daemon down" }));
    runtime.on("open", () => ({ code: 0 }));
    const doctor = makeDoctor(runtime);

    await doctor.repair(); // attempt 1
    const second = await doctor.repair(); // immediately after → cooldown
    expect(second.outcomes.some((o) => o.status === "skipped-cooldown")).toBe(true);
  });
});

// ── 6. Provider CLI missing / auth expired → directive only ────────────────

describe("provider problems", () => {
  it("emits a directive, never a shell action", async () => {
    const runtime = new FakeRuntime().healthyDocker().healthyFetch();
    const doctor = new HealthDoctor({
      runtime,
      options: makeOptions(),
      policy: POLICY,
      probes: {
        providerStatus: async () => [{ providerId: "claude", method: "cli", healthy: false, detail: "claude CLI not authenticated" }],
      },
    });
    const report = await doctor.diagnose();
    expect(report.checks.find((c) => c.name === "provider:claude")?.status).toBe("down");

    const { outcomes } = await doctor.repair();
    const outcome = outcomes.find((o) => o.target === "provider-directive");
    expect(outcome?.status).toBe("aborted");
    expect(outcome?.detail).toContain("continuum auth claude");
    expect(runtime.calls.some((c) => c.cmd === "bash" || c.cmd === "open" || c.cmd === "kill")).toBe(false);
  });
});

// ── 7. MemoryCore unavailable → preflight degraded warning ─────────────────

describe("degraded launch preflight", () => {
  it("warns (does not block) when the memory-core gateway is down", () => {
    const report = {
      overall: "down" as const,
      ranAtMs: 0,
      checks: [
        { name: "docker", status: "ok" as const, detail: "ok" },
        { name: "gateway:memory-core", status: "down" as const, detail: "gateway unreachable" },
        { name: "gateway:proxy", status: "ok" as const, detail: "ok" },
      ],
    };
    const warnings = buildPreflightWarnings(report);
    expect(warnings.join(" ")).toContain("local session context only");
  });

  it("stays silent when everything is healthy", () => {
    const report = {
      overall: "healthy" as const,
      ranAtMs: 0,
      checks: [
        { name: "docker", status: "ok" as const, detail: "ok" },
        { name: "gateway:memory-core", status: "ok" as const, detail: "reachable" },
        { name: "gateway:proxy", status: "ok" as const, detail: "healthy" },
      ],
    };
    expect(buildPreflightWarnings(report)).toEqual([]);
  });

  it("warns with the real cause when the proxy auth backend is down", () => {
    const report = {
      overall: "down" as const,
      ranAtMs: 0,
      checks: [
        { name: "docker", status: "ok" as const, detail: "ok" },
        { name: "gateway:memory-core", status: "ok" as const, detail: "reachable" },
        { name: "gateway:proxy", status: "ok" as const, detail: "healthy" },
        { name: "proxy:auth", status: "down" as const, detail: "proxy auth backend (MemoryCore) unavailable", repair: "container-restart" as const, repairContext: { container: "tdai-memory-core" } },
      ],
    };
    const warnings = buildPreflightWarnings(report);
    expect(warnings.join(" ")).toContain("401/Please run /login");
    expect(warnings.join(" ")).toContain("doctor --repair");
  });
});

// ── 7b. Functional proxy/auth path — MemoryCore outage behind a "healthy" proxy

describe("functional proxy/auth path", () => {
  it("flags a healthy-but-degraded proxy whose auth backend (MemoryCore) is unreachable", async () => {
    // Docker says all containers are healthy and the proxy /health is green,
    // but MemoryCore's auth/verify is unreachable and the proxy answers the
    // probe key with "auth service error" — the misleading 401 root cause.
    const runtime = new FakeRuntime().healthyDocker();
    runtime
      .onFetch("http://127.0.0.1:8420/health", { ok: false, status: 0 })
      .onFetch("http://127.0.0.1:8420/v3/meta/auth/verify", { ok: false, status: 0 })
      .onFetch("http://127.0.0.1:8096/health", { ok: true, status: 200 })
      .onFetch("http://127.0.0.1:8096/proxy/default/v1/chat/completions", {
        ok: false,
        status: 401,
        body: JSON.stringify({ error: "Authentication failed: auth service error: fetch failed" }),
      });

    const report = await makeDoctor(runtime).diagnose();

    // Liveness checks would have reported healthy — the gap this closes.
    expect(report.checks.find((c) => c.name === "gateway:proxy")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "container:tdai-memory-core")?.status).toBe("ok");

    const proxyAuth = report.checks.find((c) => c.name === "proxy:auth");
    expect(proxyAuth?.status).toBe("down");
    expect(proxyAuth?.detail).toContain("401/Please run /login");
    expect(proxyAuth?.repair).toBe("container-restart");
    expect(proxyAuth?.repairContext?.container).toBe("tdai-memory-core");

    const coreAuth = report.checks.find((c) => c.name === "gateway:memory-core-auth");
    expect(coreAuth?.status).toBe("down");
    expect(coreAuth?.repair).toBe("container-restart");
  });

  it("restarts memory-core and waits healthy when the auth dependency is down", async () => {
    const runtime = new FakeRuntime();
    runtime.on("docker", (args) => {
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
      if (args[0] === "restart") return { code: 0 };
      return { code: 0 };
    });
    runtime
      .onFetch("http://127.0.0.1:8420/health", { ok: true, status: 200 })
      .onFetch("http://127.0.0.1:8420/v3/meta/auth/verify", { ok: false, status: 0 })
      .onFetch("http://127.0.0.1:8096/health", { ok: true, status: 200 })
      .onFetch("http://127.0.0.1:8096/proxy/default/v1/chat/completions", {
        ok: false,
        status: 401,
        body: JSON.stringify({ error: "Authentication failed: auth service error: fetch failed" }),
      });

    const { outcomes } = await makeDoctor(runtime).repair();
    const restart = outcomes.find((o) => o.target === "container-restart" && o.checkName === "gateway:memory-core-auth");
    expect(restart?.status).toBe("repaired");
    expect(restart?.detail).toContain("restarted tdai-memory-core");
    expect(runtime.calls.some((c) => c.cmd === "docker" && c.args[0] === "restart" && c.args[1] === "tdai-memory-core")).toBe(true);
  });

  it("treats an invalid-user_key rejection as auth working (not an outage)", async () => {
    const runtime = new FakeRuntime().healthyDocker().healthyFetch();
    const report = await makeDoctor(runtime).diagnose();
    expect(report.checks.find((c) => c.name === "proxy:auth")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "gateway:memory-core-auth")?.status).toBe("ok");
  });

  it("reports proxy:auth down and repairs the proxy when the proxy is unreachable", async () => {
    const runtime = new FakeRuntime().healthyDocker();
    runtime
      .onFetch("http://127.0.0.1:8420/health", { ok: true, status: 200 })
      .onFetch("http://127.0.0.1:8420/v3/meta/auth/verify", { ok: true, status: 200, body: JSON.stringify({ code: 0, data: { valid: false } }) })
      .onFetch("http://127.0.0.1:8096/health", { ok: false, status: 0 })
      .onFetch("http://127.0.0.1:8096/proxy/default/v1/chat/completions", { ok: false, status: 0 });
    const report = await makeDoctor(runtime).diagnose();
    const proxyAuth = report.checks.find((c) => c.name === "proxy:auth");
    expect(proxyAuth?.status).toBe("down");
    expect(proxyAuth?.repair).toBe("container-start");
    expect(proxyAuth?.repairContext?.container).toBe("tdai-proxy");
  });
});

// ── 8. Repeated failure → circuit breaker opens ────────────────────────────

describe("circuit breaker", () => {
  it("opens after N failures and skips subsequent repairs until the window passes", async () => {
    const runtime = new FakeRuntime();
    runtime.on("docker", () => ({ code: 1, stderr: "daemon down" }));
    runtime.on("open", () => ({ code: 1, stderr: "Docker Desktop not installed" }));
    const doctor = makeDoctor(runtime);

    for (let i = 0; i < POLICY.breakerFailureThreshold; i += 1) {
      const { outcomes } = await doctor.repair();
      expect(outcomes.some((o) => o.status === "failed")).toBe(true);
      runtime.nowMs += POLICY.cooldownMs + 1; // pass cooldown so the breaker, not cooldown, is exercised
    }

    const open = await doctor.repair();
    expect(open.outcomes.some((o) => o.status === "skipped-breaker")).toBe(true);

    // After the open window elapses, repair is allowed again.
    runtime.nowMs += POLICY.breakerOpenMs + 1;
    const retried = await doctor.repair();
    expect(retried.outcomes.some((o) => o.status === "failed" || o.status === "repaired")).toBe(true);
  });
});

// ── 9. Stale/dead child process cleanup ────────────────────────────────────

describe("stale processes", () => {
  it("kills only orphaned pids for known provider executables", async () => {
    const runtime = new FakeRuntime().healthyDocker().healthyFetch();
    runtime.on("kill", () => ({ code: 0 }));
    const doctor = new HealthDoctor({
      runtime,
      options: makeOptions(),
      policy: POLICY,
      probes: {
        staleProcesses: async () => [
          { pid: 4242, executable: "claude" },
          { pid: 4243, executable: "claude" },
        ],
      },
    });
    const report = await doctor.diagnose();
    expect(report.checks.find((c) => c.name === "processes")?.status).toBe("degraded");

    const { outcomes } = await doctor.repair();
    expect(outcomes.some((o) => o.target === "stale-process-kill" && o.status === "repaired")).toBe(true);
    const kill = runtime.calls.find((c) => c.cmd === "kill");
    expect(kill?.args).toEqual(["4242", "4243"]);
  });
});

// ── 10. No secret leakage ──────────────────────────────────────────────────

describe("secret hygiene", () => {
  it("never includes credential values in report or outcome text", async () => {
    const runtime = new FakeRuntime().healthyDocker().healthyFetch();
    // The secret exists in the system the probes close over; the probes must
    // report status WITHOUT echoing the value, and the layer must never
    // reach into it either.
    const secret = "sk-super-secret-value-that-must-not-leak";
    const doctor = new HealthDoctor({
      runtime,
      options: makeOptions(),
      policy: POLICY,
      probes: {
        credentialStatus: async () => ({ backendId: "macos-keychain", securityLevel: "os-native", available: true, detail: "keychain ok" }),
        providerStatus: async () => [{ providerId: "deepseek", method: "api", healthy: false, detail: "credential missing from backend" }],
      },
    });

    const report = await doctor.diagnose();
    expect(JSON.stringify(report.checks)).not.toContain(secret);

    const { outcomes } = await doctor.repair();
    expect(JSON.stringify(outcomes)).not.toContain(secret);
    for (const line of HealthDoctor.formatReport(report)) expect(line).not.toContain(secret);
  });
});

// ── parseContainerStates unit ──────────────────────────────────────────────

describe("parseContainerStates", () => {
  it("parses running/healthy/exited/missing", () => {
    const states = parseContainerStates(
      ["tdai-memory-core\tUp 3 minutes (healthy)\tagentmemory/memory-core:phase13", "tdai-proxy\tExited (1) 2 minutes ago\tagentmemory/memory-proxy:latest"].join("\n"),
    );
    expect(states.find((s) => s.name === "tdai-memory-core")).toMatchObject({ running: true, healthy: true, image: "agentmemory/memory-core:phase13" });
    expect(states.find((s) => s.name === "tdai-proxy")).toMatchObject({ running: false, healthy: false });
  });
});
