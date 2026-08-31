/**
 * Read-only health checks. Each check composes low-level probes (docker CLI,
 * HTTP, credential/session store state) into a `HealthCheckResult` and never
 * mutates anything. Recovery lives in `repair.ts`.
 *
 * Every check is pure w.r.t. the runtime it is handed: the same inputs always
 * produce the same result, which is what keeps the whole layer testable.
 */
import type { HealthCheckResult, HealthOptions, HealthReport, HealthRuntime } from "./types.js";

export interface CheckDeps {
  readonly runtime: HealthRuntime;
  readonly options: HealthOptions;
  /** Presence check for provider CLI auth; undefined = skip provider checks. */
  readonly providerStatus?: () => Promise<readonly { providerId: string; method: string; healthy: boolean; detail: string }[]>;
  /** Credential backend summary; undefined = skip credential check. */
  readonly credentialStatus?: () => Promise<{ backendId: string; securityLevel: string; available: boolean; detail: string }>;
  /** Session store audit; undefined = skip store check. */
  readonly sessionStatus?: () => Promise<{ dir: string; writable: boolean; sessions: number; corrupt: string[]; exists?: boolean }>;
  /** Stale-process scan; undefined = skip. Returns orphan pids + labels. */
  readonly staleProcesses?: () => Promise<readonly { pid: number; executable: string }[]>;
}

const DOCKER_PROBE_TIMEOUT_MS = 5000;
const HTTP_PROBE_TIMEOUT_MS = 3000;
/** Must exceed the proxy's own `auth.timeoutMs` (5000ms) so a hanging MemoryCore
 *  is surfaced as "auth service timeout" rather than a premature "proxy down". */
const PROXY_AUTH_PROBE_TIMEOUT_MS = 8000;

/**
 * Functional-auth probes use an intentionally-invalid key that is NOT a
 * secret. Reaching MemoryCore with this key proves the dependency is up
 * (MemoryCore answers with `valid:false`); the proxy answering
 * `invalid user_key` proves it CAN reach MemoryCore. Both are the signals
 * that distinguish a real credential failure from a MemoryCore outage.
 */
const AUTH_PROBE_KEY = "continuum-health-probe";
/** Canonical service id the proxy forwards as `x-tdai-service-id`. */
const PROXY_SPACE_ID = "default";

async function dockerInfoOk(runtime: HealthRuntime): Promise<{ ok: boolean; detail: string }> {
  const res = await runtime.run("docker", ["info"], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
  if (res.code === 0) return { ok: true, detail: "docker daemon reachable" };
  return { ok: false, detail: firstLine(res.stderr) || "docker daemon unreachable" };
}

export interface ContainerState {
  readonly name: string;
  readonly exists: boolean;
  readonly running: boolean;
  readonly healthy: boolean;
  readonly image: string;
}

/** Parse `docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}'` output. */
export function parseContainerStates(stdout: string): ContainerState[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[1] ?? "";
      return {
        name: parts[0] ?? "",
        running: status.startsWith("Up"),
        healthy: status.includes("(healthy)"),
        image: parts[2] ?? "",
      };
    })
    .map((s) => ({ ...s, exists: s.name.length > 0 }));
}

async function containerStates(runtime: HealthRuntime): Promise<ContainerState[] | undefined> {
  const res = await runtime.run(
    "docker",
    ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"],
    { timeoutMs: DOCKER_PROBE_TIMEOUT_MS },
  );
  if (res.code !== 0) return undefined;
  return parseContainerStates(res.stdout);
}

/** Whether the optional Tencent memory stack is present (explicitly configured OR its containers exist OR they were seen on a prior pass). */
async function tencentStackPresent(runtime: HealthRuntime, options: HealthOptions): Promise<boolean> {
  if (options.tencentConfigured) return true;
  const states = await containerStates(runtime);
  if (states && states.some((s) => s.name === options.containers.memoryCore || s.name === options.containers.proxy || s.name === options.containers.hub)) {
    return true;
  }
  // `docker ps` cannot see containers through a stopped engine — the exact
  // state the docker-desktop repair exists to end. A previously-observed stack
  // (persisted `stackSeen`) or an installed Docker Desktop (Windows) is the
  // opt-in signal here, so a deployed stack is not misread as "never deployed"
  // just because its engine is stopped. The discovery fallback only applies
  // while the engine is unreachable: a REACHABLE engine with no containers
  // authoritatively means the stack was removed, and Docker Desktop staying
  // installed must not resurrect it.
  if (options.stackSeen === true) return true;
  if (states === undefined && options.dockerDesktopDiscovery) {
    const exe = await options.dockerDesktopDiscovery();
    if (exe !== undefined) return true;
  }
  return false;
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

/** One check per canonical container: running → ok, stopped → down, missing → down(recreate). */
function containerCheck(expectedName: string, state: ContainerState | undefined, opts: HealthOptions): HealthCheckResult {
  if (!state || !state.exists) {
    return {
      name: `container:${expectedName}`,
      status: "down",
      detail: `container missing`,
      repair: "container-recreate",
      repairContext: { container: expectedName },
    };
  }
  const name = `container:${state.name}`;
  if (!state.running) {
    return { name, status: "down", detail: `container stopped (image ${state.image})`, repair: "container-start", repairContext: { container: state.name } };
  }
  if (!state.healthy) {
    return { name, status: "degraded", detail: `container running but not healthy (image ${state.image})` };
  }
  return { name, status: "ok", detail: `running (image ${state.image})` };
}

/** Add docker + container + gateway + proxy checks (Tencent stack is present). */
async function addTencentChecks(checks: HealthCheckResult[], runtime: HealthRuntime, options: HealthOptions): Promise<void> {
  const docker = await dockerInfoOk(runtime);
  if (!docker.ok) {
    checks.push({ name: "docker", status: "down", detail: docker.detail, repair: "docker-desktop" });
    checks.push({ name: "container:memory-core", status: "skipped", detail: "docker unavailable" });
    checks.push({ name: "container:proxy", status: "skipped", detail: "docker unavailable" });
    checks.push({ name: "container:hub", status: "skipped", detail: "docker unavailable" });
  } else {
    checks.push({ name: "docker", status: "ok", detail: docker.detail });
    const states = (await containerStates(runtime)) ?? [];
    const find = (n: string) => states.find((s) => s.name === n);
    checks.push(containerCheck(options.containers.memoryCore, find(options.containers.memoryCore), options));
    checks.push(containerCheck(options.containers.proxy, find(options.containers.proxy), options));
    checks.push(containerCheck(options.containers.hub, find(options.containers.hub), options));
  }

  // Gateway probes (independent of container state so HTTP-only deployments still report).
  if (options.memoryCoreUrl) {
    const healthUrl = options.memoryCoreUrl.replace(/\/+$/, "") + "/health";
    const probe = await runtime.fetch(healthUrl, { timeoutMs: HTTP_PROBE_TIMEOUT_MS });
    checks.push({
      name: "gateway:memory-core",
      status: probe.ok ? "ok" : "down",
      detail: probe.ok ? `gateway reachable (HTTP ${probe.status})` : `gateway unreachable (HTTP ${probe.status})`,
      repair: probe.ok ? undefined : "container-start",
      repairContext: { container: options.containers.memoryCore },
    });
  } else {
    checks.push({ name: "gateway:memory-core", status: "skipped", detail: "CONTINUUM_MEMORY_CORE_URL not configured" });
  }

  // Functional dependency probe: the proxy verifies every user key by POSTing
  // to MemoryCore `/v3/meta/auth/verify`. When MemoryCore is down the proxy
  // stays "healthy" (its /health only reflects storage, not its auth backend),
  // so this is the check that catches the real outage behind a misleading
  // 401 / "Please run /login".
  if (options.memoryCoreUrl) {
    const verifyUrl = options.memoryCoreUrl.replace(/\/+$/, "") + "/v3/meta/auth/verify";
    const verify = await runtime.fetch(verifyUrl, {
      timeoutMs: HTTP_PROBE_TIMEOUT_MS,
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": PROXY_SPACE_ID },
      body: JSON.stringify({ user_key: AUTH_PROBE_KEY }),
    });
    const reachable = verify.status > 0;
    checks.push({
      name: "gateway:memory-core-auth",
      status: reachable ? "ok" : "down",
      detail: reachable
        ? `auth/verify reachable (HTTP ${verify.status})`
        : "auth/verify unreachable — MemoryCore dependency unavailable (proxy auth will fail with 401/Please run /login)",
      repair: reachable ? undefined : "container-restart",
      repairContext: { container: options.containers.memoryCore },
    });
  } else {
    checks.push({ name: "gateway:memory-core-auth", status: "skipped", detail: "CONTINUUM_MEMORY_CORE_URL not configured" });
  }

  const proxyProbe = await runtime.fetch(options.proxyHealthUrl, { timeoutMs: HTTP_PROBE_TIMEOUT_MS });
  checks.push({
    name: "gateway:proxy",
    status: proxyProbe.ok ? "ok" : "down",
    detail: proxyProbe.ok ? `proxy healthy (HTTP ${proxyProbe.status})` : `proxy unreachable (HTTP ${proxyProbe.status})`,
    repair: proxyProbe.ok ? undefined : "container-start",
    repairContext: { container: options.containers.proxy },
  });

  // Functional proxy/auth path.
  {
    let proxyBase: string;
    try {
      proxyBase = new URL(options.proxyHealthUrl).origin;
    } catch {
      proxyBase = options.proxyHealthUrl.replace(/\/health\/?$/, "").replace(/\/+$/, "");
    }
    const authProbe = await runtime.fetch(`${proxyBase}/proxy/${PROXY_SPACE_ID}/v1/chat/completions`, {
      timeoutMs: PROXY_AUTH_PROBE_TIMEOUT_MS,
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${AUTH_PROBE_KEY}` },
      body: JSON.stringify({ model: "continuum-health-probe", messages: [] }),
    });
    const body = (authProbe.body ?? "").toLowerCase();
    let proxyAuth: HealthCheckResult;
    if (authProbe.status === 0) {
      proxyAuth = {
        name: "proxy:auth",
        status: "down",
        detail: "proxy unreachable — provider traffic cannot be routed",
        repair: "container-start",
        repairContext: { container: options.containers.proxy },
      };
    } else if (authProbe.status === 401 && body.includes("auth service")) {
      proxyAuth = {
        name: "proxy:auth",
        status: "down",
        detail: "proxy auth backend (MemoryCore) unavailable — Claude Code shows 401/Please run /login until MemoryCore is recovered",
        repair: "container-restart",
        repairContext: { container: options.containers.memoryCore },
      };
    } else if (authProbe.status === 401) {
      proxyAuth = {
        name: "proxy:auth",
        status: "ok",
        detail: `auth verification working (probe key correctly rejected, HTTP ${authProbe.status})`,
      };
    } else {
      proxyAuth = { name: "proxy:auth", status: "ok", detail: `auth path responding (HTTP ${authProbe.status})` };
    }
    checks.push(proxyAuth);
  }
}

/** Build the docker + gateway + provider + store checks. */
export async function runHealthChecks(deps: CheckDeps): Promise<readonly HealthCheckResult[]> {
  const { runtime, options } = deps;
  const checks: HealthCheckResult[] = [];

  // The Tencent memory stack is OPTIONAL. When it's neither configured nor
  // deployed, report it as "skipped" rather than a scary "down".
  const tencentPresent = await tencentStackPresent(runtime, options);
  if (!tencentPresent) {
    checks.push({
      name: "tencent-memory",
      status: "skipped",
      detail: "Tencent memory stack not deployed (optional) — memory/context features degrade to local session context",
    });
    checks.push({ name: "docker", status: "skipped", detail: "not required (Tencent memory stack not configured)" });
    checks.push({ name: "container:memory-core", status: "skipped", detail: "not required" });
    checks.push({ name: "container:proxy", status: "skipped", detail: "not required" });
    checks.push({ name: "container:hub", status: "skipped", detail: "not required" });
    checks.push({ name: "gateway:memory-core", status: "skipped", detail: "not required" });
    checks.push({ name: "gateway:memory-core-auth", status: "skipped", detail: "not required" });
    checks.push({ name: "gateway:proxy", status: "skipped", detail: "not required" });
    checks.push({ name: "proxy:auth", status: "skipped", detail: "not required" });
  } else {
    await addTencentChecks(checks, runtime, options);
  }

  if (deps.providerStatus) {
    const findings = await deps.providerStatus();
    for (const f of findings) {
      checks.push({
        name: `provider:${f.providerId}`,
        status: f.healthy ? "ok" : "down",
        detail: `${f.method}: ${f.detail}`,
        repair: f.healthy ? undefined : "provider-directive",
        repairContext: { providerId: f.providerId },
      });
    }
  } else {
    checks.push({ name: "provider", status: "skipped", detail: "provider status unavailable" });
  }

  if (deps.credentialStatus) {
    const cred = await deps.credentialStatus();
    checks.push({
      name: "credentials",
      status: cred.available ? "ok" : "down",
      detail: `${cred.backendId} (${cred.securityLevel}): ${cred.detail}`,
      repair: cred.available ? undefined : "credential-directive",
    });
  } else {
    checks.push({ name: "credentials", status: "skipped", detail: "credential backend unavailable" });
  }

  if (deps.sessionStatus) {
    const sess = await deps.sessionStatus();
    const exists = (sess as { exists?: boolean }).exists ?? true;
    // A missing dir on a fresh install is normal (created on first launch) —
    // only an existing-but-unwritable dir or corrupt files are degraded.
    const down = exists && (!sess.writable || sess.corrupt.length > 0);
    checks.push({
      name: "sessions",
      status: down ? "degraded" : "ok",
      detail: down
        ? `${sess.dir}: ${sess.writable ? "" : "dir not writable, "}${sess.corrupt.length} corrupt session file(s)`
        : exists
          ? `${sess.dir}: ${sess.sessions} session(s), store healthy`
          : `${sess.dir}: no session store yet (created on first launch)`,
    });
  } else {
    checks.push({ name: "sessions", status: "skipped", detail: "session store unavailable" });
  }

  if (deps.staleProcesses) {
    const stale = await deps.staleProcesses();
    if (stale.length === 0) {
      checks.push({ name: "processes", status: "ok", detail: "no orphaned provider processes" });
    } else {
      checks.push({
        name: "processes",
        status: "degraded",
        detail: `${stale.length} orphaned provider process(es): ${stale.map((p) => `${p.executable}(${p.pid})`).join(", ")}`,
        repair: "stale-process-kill",
        repairContext: { pids: stale.map((p) => String(p.pid)).join(",") },
      });
    }
  } else {
    checks.push({ name: "processes", status: "skipped", detail: "process scan unavailable" });
  }

  return checks;
}

/** Aggregate a set of checks into the report's overall state. */
export function overallOf(checks: readonly HealthCheckResult[]): HealthReport["overall"] {
  if (checks.some((c) => c.status === "down")) return "down";
  if (checks.some((c) => c.status === "degraded")) return "degraded";
  return "healthy";
}
