/**
 * Launch-time stack self-heal (health/launch-heal.ts) — the fix for
 * "CONTINUUM.app launches straight into degraded mode with Docker/Tencent
 * stopped and never tries to recover". The regression matrix the report asked
 * for:
 *
 *   healthy stack            → no repair, no warnings
 *   Docker down              → same launch auto-repairs the full stack
 *   Docker cold-boots slowly → same launch still recovers (no rerun)
 *   Docker up, containers down→ containers started
 *   gateway down             → POST-repair state used, not the frozen one
 *   unrecoverable            → one concise degraded-mode warning
 *   after a successful repair → zero stale degraded-mode warnings
 *   concurrent launches      → second launch never starts a competing repair
 *
 * Reuses the real HealthDoctor (checks.ts + repair.ts + state.ts) against a
 * fake runtime — no second recovery path is exercised.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HealthOptions, HealthRuntime, RecoveryPolicy } from "../types.js";
import type { RepairLock } from "../repair-lock.js";
import { ensureLaunchStackHealthy } from "../launch-heal.js";
import { RecoveryState } from "../state.js";

interface CmdResult {
  code: number | null;
  stdout?: string;
  stderr?: string;
}

const IMAGE: Record<string, string> = {
  "tdai-memory-core": "agentmemory/memory-core:phase13",
  "tdai-proxy": "agentmemory/memory-proxy:latest",
  "tdai-memory-hub": "agentmemory/memory-hub:latest",
};
const ALL = Object.keys(IMAGE);

/**
 * A stack that starts fully stopped. `open -a Docker` boots the daemon (after
 * `bootDelayInfoCalls` further `docker info` polls, to model a cold boot);
 * `docker start <c>` marks a container up; gateways answer only once the
 * daemon is up and every container it fronts is started.
 */
class StackRuntime implements HealthRuntime {
  nowMs = 1_000_000;
  now = () => this.nowMs;
  calls: { cmd: string; args: readonly string[] }[] = [];

  dockerUp = false;
  dockerBooting = false;
  bootDelayInfoCalls = 0;
  private infoCallsSinceOpen = 0;
  started = new Set<string>();
  /** Simulate Docker Desktop's terminal "engine cannot boot" daemon error. */
  terminalError = false;
  /** Simulate a `docker info` that hangs its whole timeout (engine up, VM dead). */
  hangInfo = false;
  /** Simulate an engine that is up but has NO containers (stack genuinely removed). */
  noContainers = false;

  constructor(opts?: { dockerUp?: boolean; started?: string[]; bootDelayInfoCalls?: number; terminalError?: boolean; hangInfo?: boolean; noContainers?: boolean }) {
    this.dockerUp = opts?.dockerUp ?? false;
    this.bootDelayInfoCalls = opts?.bootDelayInfoCalls ?? 0;
    this.terminalError = opts?.terminalError ?? false;
    this.hangInfo = opts?.hangInfo ?? false;
    this.noContainers = opts?.noContainers ?? false;
    for (const c of opts?.started ?? []) this.started.add(c);
    if (this.dockerUp && !opts?.started) for (const c of ALL) this.started.add(c);
  }

  async run(cmd: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    this.calls.push({ cmd, args });
    if (cmd === "open" && args[0] === "-a" && args[1] === "Docker") {
      this.dockerBooting = true;
      this.infoCallsSinceOpen = 0;
      if (this.bootDelayInfoCalls === 0) this.dockerUp = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "docker") return this.docker(args);
    return { code: 0, stdout: "", stderr: "" };
  }

  /** Detached GUI launch (Windows Docker Desktop.exe) — boots the daemon like `open`. */
  async start(cmd: string, args: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({ cmd, args });
    if (cmd.endsWith("Docker Desktop.exe")) {
      this.dockerBooting = true;
      this.infoCallsSinceOpen = 0;
      // In the terminal/hang failure modes, launching the exe must NOT boot the
      // daemon — the engine stays down so the repair exercises those paths.
      if (!this.terminalError && !this.hangInfo && this.bootDelayInfoCalls === 0) this.dockerUp = true;
      return { ok: true };
    }
    return { ok: true };
  }

  private docker(args: readonly string[]): { code: number | null; stdout: string; stderr: string } {
    const sub = args[0];
    if (sub === "info") {
      if (this.terminalError && !this.dockerUp) {
        return { code: 1, stdout: "", stderr: "ERROR: Error response from daemon: Docker Desktop is unable to start" };
      }
      if (this.hangInfo && !this.dockerUp) {
        this.nowMs += 30_000; // consume the poll's whole 30s timeout
        return { code: 1, stdout: "", stderr: "" };
      }
      if (!this.dockerUp && this.dockerBooting) {
        this.infoCallsSinceOpen += 1;
        if (this.infoCallsSinceOpen >= this.bootDelayInfoCalls) this.dockerUp = true;
      }
      return this.dockerUp ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    }
    if (!this.dockerUp) return { code: 1, stdout: "", stderr: "daemon down" };
    if (sub === "ps" && this.noContainers) return { code: 0, stdout: "", stderr: "" };
    if (sub === "ps") {
      const line = (n: string) =>
        `${n}\t${this.started.has(n) ? "Up 2 seconds (healthy)" : "Exited (255) 16 hours ago"}\t${IMAGE[n]}`;
      return { code: 0, stdout: ALL.map(line).join("\n"), stderr: "" };
    }
    if (sub === "start") {
      this.started.add(args[1] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (sub === "restart") {
      this.started.add(args[1] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (sub === "inspect") return { code: 0, stdout: "healthy", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  async fetch(url: string): Promise<{ ok: boolean; status: number; body?: string }> {
    const serving = this.dockerUp && ALL.every((c) => this.started.has(c));
    if (!serving) return { ok: false, status: 0 };
    if (url.includes("/v3/meta/auth/verify")) return { ok: true, status: 200, body: JSON.stringify({ code: 0, data: { valid: false } }) };
    if (url.includes("/proxy/default/v1/chat/completions")) return { ok: false, status: 401, body: "invalid user_key" };
    return { ok: true, status: 200 };
  }

  async sleep(ms: number): Promise<void> {
    this.nowMs += ms;
  }
}

function tmpStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "launch-heal-")), "health-state.json");
}

function options(overrides?: Partial<HealthOptions>): HealthOptions {
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

const dockerCalls = (r: StackRuntime, sub: string) => r.calls.filter((c) => c.cmd === "docker" && c.args[0] === sub);
const openedDocker = (r: StackRuntime) => r.calls.some((c) => c.cmd === "open" && c.args[1] === "Docker");

describe("ensureLaunchStackHealthy — already healthy", () => {
  it("does not repair and emits no warnings when the whole stack is up", async () => {
    const runtime = new StackRuntime({ dockerUp: true });
    const result = await ensureLaunchStackHealthy({ runtime, options: options(), policy: POLICY });

    expect(result).toEqual({ warnings: [], repairAttempted: false, recovered: false });
    expect(openedDocker(runtime)).toBe(false);
    expect(dockerCalls(runtime, "start")).toEqual([]);
  });

  it("stays warn-only (never repairs) when no Tencent stack is configured or deployed", async () => {
    const runtime = new StackRuntime({ dockerUp: false });
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options({ tencentConfigured: false }),
      policy: POLICY,
      // Hermetic: no Docker Desktop installed — otherwise the discovery
      // fallback would arm the docker-desktop repair on a Windows test host
      // that happens to have Docker Desktop.
      discoverDockerDesktop: async () => undefined,
    });

    expect(result.repairAttempted).toBe(false);
    expect(openedDocker(runtime)).toBe(false);
    expect(dockerCalls(runtime, "start")).toEqual([]);
  });
});

describe("ensureLaunchStackHealthy — Docker down", () => {
  it("boots Docker Desktop and starts every container in the same launch", async () => {
    const runtime = new StackRuntime({ dockerUp: false });
    const progress: string[] = [];
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      discoverDockerDesktop: async () => undefined,
      onProgress: (l) => progress.push(l),
    });

    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(openedDocker(runtime)).toBe(true);
    expect(new Set(dockerCalls(runtime, "start").map((c) => c.args[1]))).toEqual(new Set(ALL));
    expect(progress.some((l) => /attempting automatic recovery/i.test(l))).toBe(true);
    expect(progress.some((l) => /recovered/i.test(l))).toBe(true);
  });

  it("recovers on the same launch even when the Docker daemon cold-boots slowly", async () => {
    const runtime = new StackRuntime({ dockerUp: false, bootDelayInfoCalls: 5 });
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      discoverDockerDesktop: async () => undefined,
    });

    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(dockerCalls(runtime, "info").length).toBeGreaterThan(5); // polled through the boot
  });

  it("Windows: launches the discovered Docker Desktop executable and recovers the stack", async () => {
    const runtime = new StackRuntime({ dockerUp: false });
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      discoverDockerDesktop: async () => exe,
    });

    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
    // The discovered exe was launched detached — `open -a Docker` was NOT used.
    expect(openedDocker(runtime)).toBe(false);
    expect(runtime.calls.some((c) => c.cmd === exe && c.args.length === 0)).toBe(true);
    // Same-launch cascade then started every container.
    expect(new Set(dockerCalls(runtime, "start").map((c) => c.args[1]))).toEqual(new Set(ALL));
  });
});

/** Seed the persisted `stackSeen` marker the way a prior healthy launch would. */
async function writeStackSeen(stateFile: string): Promise<void> {
  const s = new RecoveryState(stateFile, POLICY, () => 0);
  await s.load();
  s.markStackSeen();
  await s.persist();
}

async function readStackSeen(stateFile: string): Promise<boolean> {
  const s = new RecoveryState(stateFile, POLICY, () => 0);
  await s.load();
  return s.stackSeen();
}

describe("ensureLaunchStackHealthy — deployed stack behind a stopped engine (persisted stackSeen)", () => {
  // Regression for the exact Windows failure: the stack IS deployed, but the
  // engine that would reveal its containers is the very thing recovery must
  // start. Without the persisted marker, `tencentStackPresent` sees an empty
  // `docker ps` (daemon down), reports the stack "skipped", and the
  // docker-desktop repair never arms — Docker Desktop is never launched.
  it("starts Docker Desktop on a stopped engine when the stack's containers were previously observed", async () => {
    const stateFile = tmpStateFile();
    await writeStackSeen(stateFile);
    const runtime = new StackRuntime({ dockerUp: false });
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options({ stateFile, tencentConfigured: false }),
      policy: POLICY,
      discoverDockerDesktop: async () => exe,
    });

    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
    // The discovered exe was launched detached (NOT `open -a Docker`).
    expect(runtime.calls.some((c) => c.cmd === exe && c.args.length === 0)).toBe(true);
    // Same-launch cascade then started every container.
    expect(new Set(dockerCalls(runtime, "start").map((c) => c.args[1]))).toEqual(new Set(ALL));
  });

  it("records stackSeen on a healthy launch, then auto-starts Docker on a later stopped engine", async () => {
    const stateFile = tmpStateFile();
    const healthy = await ensureLaunchStackHealthy({
      runtime: new StackRuntime({ dockerUp: true }),
      options: options({ stateFile, tencentConfigured: false }),
      policy: POLICY,
    });
    expect(healthy.warnings).toEqual([]);
    expect(await readStackSeen(stateFile)).toBe(true);

    const stopped = await ensureLaunchStackHealthy({
      runtime: new StackRuntime({ dockerUp: false }),
      options: options({ stateFile, tencentConfigured: false }),
      policy: POLICY,
    });
    expect(stopped.recovered).toBe(true);
    expect(stopped.warnings).toEqual([]);
  });

  it("clears the marker when the engine is up and the containers are genuinely gone", async () => {
    const stateFile = tmpStateFile();
    await writeStackSeen(stateFile);
    const result = await ensureLaunchStackHealthy({
      runtime: new StackRuntime({ dockerUp: true, noContainers: true }),
      options: options({ stateFile, tencentConfigured: false }),
      policy: POLICY,
    });

    // The (stale) marker must not keep the optional stack armed forever — an
    // engine with no containers means the stack was removed.
    expect(await readStackSeen(stateFile)).toBe(false);
    expect(result.repairAttempted).toBe(true);
  });
});

describe("ensureLaunchStackHealthy — Docker Desktop installed but memory not configured (no token, no marker)", () => {
  // Regression for the REAL Windows desktop launch. Reproduces this machine's
  // verified-live state exactly: no memory token stored (so tencentConfigured
  // is false), no prior stackSeen marker, and the engine stopped — yet Docker
  // Desktop IS installed. Before the discovery fallback, `tencentStackPresent`
  // read the unreachable `docker ps` as "stack never deployed", every Tencent
  // check came back [skipped] with no repair, `isRecoverable` found nothing,
  // and Docker Desktop was never launched. The installed Docker Desktop is the
  // opt-in signal that the stack is deployed but invisible through its engine.
  it("auto-starts Docker Desktop purely from an installed Docker Desktop, then recovers the stack", async () => {
    const runtime = new StackRuntime({ dockerUp: false });
    const exe = "C:\\Users\\Adminn\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe";
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options({ tencentConfigured: false }), // fresh stateFile → no stackSeen marker
      policy: POLICY,
      discoverDockerDesktop: async () => exe,
    });

    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
    // The discovered exe was launched detached — the repair armed with no
    // memory config and no prior marker, purely on Docker Desktop's presence.
    expect(runtime.calls.some((c) => c.cmd === exe && c.args.length === 0)).toBe(true);
    // Same-launch cascade then started every container.
    expect(new Set(dockerCalls(runtime, "start").map((c) => c.args[1]))).toEqual(new Set(ALL));
  });

  it("does NOT arm the stack when the engine is REACHABLE but has no containers, even with Docker Desktop installed", async () => {
    // An engine that answers `docker ps` with nothing authoritatively means the
    // stack was removed — Docker Desktop staying installed must not resurrect
    // a deliberately-deployed-down stack. The discovery fallback only applies
    // while the engine itself is unreachable.
    const runtime = new StackRuntime({ dockerUp: true, noContainers: true });
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options({ tencentConfigured: false }),
      policy: POLICY,
      discoverDockerDesktop: async () => "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    });

    expect(result.repairAttempted).toBe(false);
    expect(runtime.calls.some((c) => c.cmd.includes("Docker Desktop.exe"))).toBe(false);
  });
});

describe("ensureLaunchStackHealthy — Docker up, services down", () => {
  it("starts stopped containers without touching Docker Desktop", async () => {
    const runtime = new StackRuntime({ dockerUp: true, started: [] });
    const result = await ensureLaunchStackHealthy({ runtime, options: options(), policy: POLICY });

    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(openedDocker(runtime)).toBe(false);
    expect(new Set(dockerCalls(runtime, "start").map((c) => c.args[1]))).toEqual(new Set(ALL));
  });

  it("recovers a deployed stack even without a memory token — the containers are the opt-in signal", async () => {
    // Regression: the old heal short-circuited on `memoryConfigured` (token in
    // vault/env). A user with the stack deployed but no token stored never got
    // auto-recovery. The stack's own presence (docker up + its containers
    // stopped) must be enough to arm the existing repair cascade.
    const runtime = new StackRuntime({ dockerUp: true, started: [] });
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options({ tencentConfigured: false }),
      policy: POLICY,
    });

    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(new Set(dockerCalls(runtime, "start").map((c) => c.args[1]))).toEqual(new Set(ALL));
  });

  it("uses the POST-repair gateway state, never the frozen pre-repair diagnosis", async () => {
    // Containers report 'running' from the start, but the gateway only answers
    // once a start/restart has kicked the memory-core. A launch that trusted
    // the first diagnosis would degrade; this one must recover.
    const runtime = new StackRuntime({ dockerUp: true, started: [] });
    runtime.started = new Set(ALL); // containers 'up'…
    const realFetch = runtime.fetch.bind(runtime);
    let kicked = false;
    runtime.fetch = async (url: string) => {
      if (!kicked) return { ok: false, status: 0 };
      return realFetch(url);
    };
    const realRun = runtime.run.bind(runtime);
    runtime.run = async (cmd, args) => {
      const r = await realRun(cmd, args);
      if (cmd === "docker" && (args[0] === "start" || args[0] === "restart")) kicked = true;
      return r;
    };

    const result = await ensureLaunchStackHealthy({ runtime, options: options(), policy: POLICY });
    expect(result.recovered).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("ensureLaunchStackHealthy — Docker Desktop cannot boot its engine", () => {
  it("Windows: fails fast with the exact reason when Docker reports a terminal engine error", async () => {
    // Regression: a terminal "Docker Desktop is unable to start" used to be
    // ignored — the repair polled the full 180s and then printed the same
    // generic "not ready" line. It must surface the real reason immediately.
    const runtime = new StackRuntime({ dockerUp: false, terminalError: true });
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    const progress: string[] = [];
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      discoverDockerDesktop: async () => exe,
      onProgress: (l) => progress.push(l),
    });

    expect(result.recovered).toBe(false);
    expect(result.repairAttempted).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/unable to start/i);
    // Explicit startup progress, then fail fast — no blind retry loop.
    expect(progress.some((l) => /Starting Docker Desktop/.test(l))).toBe(true);
    expect(progress.some((l) => /waiting for engine/.test(l))).toBe(true);
    // Launch diagnose + repair's before/after diagnoses + the single repair
    // poll. A blind loop would have burned ~90 polls, not 4.
    expect(dockerCalls(runtime, "info").length).toBe(4);
  });

  it("Windows: fails fast with the WSL/virtualization reason when the engine hangs and the prerequisite is missing", async () => {
    // Regression: a hung `docker info` (engine process up, VM never reachable)
    // was polled until the 180s deadline then reported generically. The
    // prerequisite probe must run once and surface the real machine-level cause.
    const runtime = new StackRuntime({ dockerUp: false, hangInfo: true });
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    let probeCalls = 0;
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      discoverDockerDesktop: async () => exe,
      probeEnginePrerequisite: async () => {
        probeCalls += 1;
        return { ok: false, detail: "this machine reports virtualization disabled (WSL2 cannot start)" };
      },
    });

    expect(result.recovered).toBe(false);
    expect(probeCalls).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/virtualization disabled/i);
    expect(result.warnings[0]).toMatch(/wsl2 cannot start/i);
  });

  it("Windows: keeps polling (probing once) when the prerequisite is satisfied but the engine is still hanging", async () => {
    const runtime = new StackRuntime({ dockerUp: false, hangInfo: true });
    let probeCalls = 0;
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      discoverDockerDesktop: async () => "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
      probeEnginePrerequisite: async () => {
        probeCalls += 1;
        return { ok: true, detail: "" };
      },
    });

    // A healthy prerequisite is not a false failure: the poll keeps running
    // until the wait window elapses, and the probe runs exactly once.
    expect(probeCalls).toBe(1);
    expect(result.recovered).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/not ready within/i);
  });
});

describe("ensureLaunchStackHealthy — unrecoverable", () => {
  it("degrades with exactly one concise, actionable warning when Docker never comes up", async () => {
    const runtime = new StackRuntime({ dockerUp: false, bootDelayInfoCalls: 100_000 }); // never boots
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      discoverDockerDesktop: async () => undefined,
    });

    expect(result.recovered).toBe(false);
    expect(result.repairAttempted).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/auto-recovery incomplete/i);
    expect(result.warnings[0]).toMatch(/continuum doctor --repair/);
    expect(result.warnings[0]).not.toMatch(/sk-|token|secret|bearer/i);
  });
});

describe("ensureLaunchStackHealthy — concurrency", () => {
  it("a second launch does not start a competing repair while another holds the lock", async () => {
    const runtime = new StackRuntime({ dockerUp: false });
    const busyLock: RepairLock = {
      acquire: async () => ({ acquired: false, waited: true }),
      release: async () => {},
    };
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      lock: busyLock,
    });

    // It diagnosed and reported, but never fired its own Docker Desktop boot
    // or `docker start` — the launch holding the lock owns recovery.
    expect(openedDocker(runtime)).toBe(false);
    expect(dockerCalls(runtime, "start")).toEqual([]);
    expect(result.repairAttempted).toBe(true);
  });

  it("skips repair when the launch it waited on already recovered the stack", async () => {
    // Starts down; the lock we're waiting on belongs to another launch whose
    // repair finishes (stack comes up) just as we acquire it.
    const runtime = new StackRuntime({ dockerUp: false });
    const waitedLock: RepairLock = {
      acquire: async () => {
        runtime.dockerUp = true;
        for (const c of ALL) runtime.started.add(c);
        return { acquired: true, waited: true };
      },
      release: async () => {},
    };
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      lock: waitedLock,
    });

    expect(result.recovered).toBe(true);
    expect(openedDocker(runtime)).toBe(false);
    expect(dockerCalls(runtime, "start")).toEqual([]);
  });

  it("a lock orphaned by a killed launch does NOT wedge the next launch's recovery", async () => {
    // A previous launch was SIGKILLed mid-recovery and left its lock file
    // behind, naming a pid that is no longer running.
    const stateFile = tmpStateFile();
    const lockPath = join(dirname(stateFile), "health-repair.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, host: hostname(), at: Date.now() - 60_000 }));

    const runtime = new StackRuntime({ dockerUp: false });
    const result = await ensureLaunchStackHealthy({
      runtime,
      options: options({ stateFile }),
      policy: POLICY,
      discoverDockerDesktop: async () => undefined,
    });

    // The dead owner's lock was reclaimed and THIS launch ran the recovery.
    expect(openedDocker(runtime)).toBe(true);
    expect(result.repairAttempted).toBe(true);
    expect(existsSync(lockPath)).toBe(false); // released on the normal path
  });

  it("emits visible progress while waiting on a peer launch's repair", async () => {
    const runtime = new StackRuntime({ dockerUp: false });
    const progress: string[] = [];
    const busyLock: RepairLock = {
      acquire: async (_ms, opts) => {
        opts?.onWait?.("another launch is recovering the stack — waiting… (2s)");
        return { acquired: false, waited: true };
      },
      release: async () => {},
    };
    await ensureLaunchStackHealthy({
      runtime,
      options: options(),
      policy: POLICY,
      lock: busyLock,
      onProgress: (l) => progress.push(l),
    });

    expect(progress.some((l) => /waiting/i.test(l))).toBe(true);
    expect(progress.some((l) => /still recovering the stack/i.test(l))).toBe(true);
  });
});
