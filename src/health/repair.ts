/**
 * Explicit, bounded recovery actions behind `continuum doctor --repair`.
 *
 * Repair policy, in order of importance:
 *   1. NEVER silently fall back to the registry `latest` image — the pinned
 *      `:phase13` image is read from the canonical Tencent `.env` before any
 *      recreate path runs, and a mismatch ABORTS the repair with an
 *      actionable error instead of risking a revert.
 *   2. NO broad recreation when a service is merely stopped or functionally
 *      degraded — an existing container is restarted with `docker start` (or
 *      `docker restart` for a running-but-broken auth dependency), config
 *      untouched. The canonical `mac/start-tencent.sh` recreate path runs only
 *      when a container is genuinely MISSING.
 *   3. All side effects are gated by cooldown + circuit-breaker state, so a
 *      failing repair cannot hammer the stack or loop forever.
 *   4. Provider/credential problems never get auto-mutated here — those
 *      return directives that point at the existing setup/auth commands.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HealthCheckResult, HealthOptions, HealthRuntime, RepairOutcome } from "./types.js";
import { RecoveryState } from "./state.js";

const SCRIPT_TIMEOUT_MS = 180_000;
const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_DESKTOP_WAIT_MS = 30_000;
const DOCKER_DESKTOP_POLL_MS = 2000;
const CONTAINER_HEALTHY_WAIT_MS = 60_000;
const CONTAINER_HEALTHY_POLL_MS = 2000;

export interface RepairDeps {
  readonly runtime: HealthRuntime;
  readonly options: HealthOptions;
  readonly state: RecoveryState;
  /** Injectable env read so tests never touch the real canonical repo. */
  readonly readPinnedEnv?: () => Promise<string | undefined>;
}

/** Read `MEMORY_CORE_IMAGE` from the canonical Tencent `.env`. */
async function readPinnedImageFromEnv(options: HealthOptions, runtime: HealthRuntime): Promise<string | undefined> {
  // The canonical deploy env lives two levels above mac/ (repo/deploy/global-images/.env).
  const envPath = join(dirname(options.tencentMacDir), "deploy", "global-images", ".env");
  try {
    const content = await readFile(envPath, "utf8");
    const line = content.split("\n").find((l) => l.trim().startsWith("MEMORY_CORE_IMAGE="));
    return line ? line.split("=", 2)[1]?.trim() : undefined;
  } catch {
    void runtime; // unreadable env is handled by the caller as an abort
    return undefined;
  }
}

async function dockerStart(runtime: HealthRuntime, container: string): Promise<RepairOutcome["status"] | "missing"> {
  const res = await runtime.run("docker", ["start", container], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (res.code === 0) return "repaired";
  if (firstLine(res.stderr).includes("No such container") || firstLine(res.stderr).includes("not found")) return "missing";
  return "failed";
}

async function dockerRestart(runtime: HealthRuntime, container: string): Promise<RepairOutcome["status"] | "missing"> {
  const res = await runtime.run("docker", ["restart", container], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (res.code === 0) return "repaired";
  if (firstLine(res.stderr).includes("No such container") || firstLine(res.stderr).includes("not found")) return "missing";
  return "failed";
}

/**
 * Poll `docker inspect` until a container reports `healthy` (or, when it has
 * no healthcheck, `running`). Recovery is only "repaired" once the service is
 * actually ready — a `docker start` that leaves a container in `starting` or
 * `unhealthy` is not a successful repair.
 */
async function waitForContainerHealthy(runtime: HealthRuntime, container: string): Promise<{ ok: boolean; detail: string }> {
  const deadline = runtime.now() + CONTAINER_HEALTHY_WAIT_MS;
  while (runtime.now() < deadline) {
    const res = await runtime.run(
      "docker",
      ["inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container],
      { timeoutMs: DOCKER_TIMEOUT_MS },
    );
    const state = firstLine(res.stdout) || "missing";
    if (state === "healthy" || state === "running") return { ok: true, detail: state };
    if (res.code !== 0 && (firstLine(res.stderr).includes("No such object") || firstLine(res.stderr).includes("not found"))) {
      return { ok: false, detail: `container ${container} missing` };
    }
    await runtime.sleep(CONTAINER_HEALTHY_POLL_MS);
  }
  return { ok: false, detail: `container ${container} not healthy within ${CONTAINER_HEALTHY_WAIT_MS}ms` };
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

/**
 * Cooldown/breaker key for a recovery attempt. Keyed on the *subject* being
 * repaired (the container, provider, or process set), NOT the check that
 * observed the failure — so a single MemoryCore outage observed by four
 * different checks (container + gateway + auth-dependency + proxy-auth) only
 * triggers ONE recovery attempt per pass, instead of restarting the same
 * container four times.
 */
function repairKey(check: HealthCheckResult): string {
  const target = check.repair ?? "none";
  const ctx = check.repairContext ?? {};
  switch (target) {
    case "container-start":
    case "container-restart":
    case "container-recreate":
      return `container:${ctx.container ?? ""}`;
    case "docker-desktop":
      return "docker-desktop";
    case "provider-directive":
      return `provider:${ctx.providerId ?? ""}`;
    case "credential-directive":
      return "credential-directive";
    case "stale-process-kill":
      return `processes:${ctx.pids ?? ""}`;
    default:
      return target;
  }
}

/**
 * Run the canonical Mac stack start script — the one recreate path. Only
 * reachable when a container is missing AND the pinned-image guard passed.
 */
async function runCanonicalStart(deps: RepairDeps): Promise<{ ok: boolean; detail: string }> {
  const { runtime, options } = deps;
  const script = join(options.tencentMacDir, "start-tencent.sh");
  const res = await runtime.run("bash", [script], { timeoutMs: SCRIPT_TIMEOUT_MS });
  const detail = (res.code === 0 ? res.stdout : res.stderr || res.stdout).split("\n").filter((l) => l.trim()).slice(-3).join(" | ");
  return { ok: res.code === 0, detail: detail || "start script completed" };
}

async function waitForDockerDesktop(runtime: HealthRuntime): Promise<{ ok: boolean; detail: string }> {
  const open = await runtime.run("open", ["-a", "Docker"], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (open.code !== 0) {
    return { ok: false, detail: `could not launch Docker Desktop: ${firstLine(open.stderr)}` };
  }
  const deadline = runtime.now() + DOCKER_DESKTOP_WAIT_MS;
  while (runtime.now() < deadline) {
    const info = await runtime.run("docker", ["info"], { timeoutMs: DOCKER_TIMEOUT_MS });
    if (info.code === 0) return { ok: true, detail: "Docker Desktop started, daemon reachable" };
    await runtime.sleep(DOCKER_DESKTOP_POLL_MS);
  }
  return { ok: false, detail: "Docker Desktop launched but daemon not ready within 30s" };
}

async function repairTarget(deps: RepairDeps, check: HealthCheckResult): Promise<RepairOutcome> {
  const { runtime, options, state } = deps;
  const target = check.repair;
  if (!target) return { target: "provider-directive", checkName: check.name, status: "aborted", detail: "no repair strategy" };

  const key = repairKey(check);
  const gate = state.canAttempt(key);
  if (!gate.allowed) {
    const detail =
      gate.reason === "breaker-open"
        ? `circuit breaker open until ${new Date(gate.openUntilMs ?? 0).toISOString()} — refusing auto-repair`
        : "cooldown active — repair attempted too recently, skipping";
    return { target, checkName: check.name, status: gate.reason === "breaker-open" ? "skipped-breaker" : "skipped-cooldown", detail };
  }

  state.recordAttempt(key);

  switch (target) {
    case "docker-desktop": {
      const res = await waitForDockerDesktop(runtime);
      if (res.ok) {
        state.recordSuccess(key);
        return { target, checkName: check.name, status: "repaired", detail: res.detail };
      }
      const { breakerOpened } = state.recordFailure(key);
      return { target, checkName: check.name, status: "failed", detail: `${res.detail}${breakerOpened ? " — circuit breaker OPENED" : ""}` };
    }

    case "container-start": {
      const container = check.repairContext?.container ?? options.containers.memoryCore;
      const res = await dockerStart(runtime, container);
      if (res === "missing") {
        // Race: container vanished between check and repair. The recreate
        // path has its own check + guard, so surface this and let a rerun
        // pick the right strategy instead of improvising one here.
        state.recordSuccess(key);
        return { target, checkName: check.name, status: "aborted", detail: `container ${container} disappeared — rerun doctor to use the recreate path` };
      }
      if (res !== "repaired") {
        const { breakerOpened } = state.recordFailure(key);
        return { target, checkName: check.name, status: "failed", detail: `docker start ${container} failed${breakerOpened ? " — circuit breaker OPENED" : ""}` };
      }
      const wait = await waitForContainerHealthy(runtime, container);
      if (wait.ok) {
        state.recordSuccess(key);
        return { target, checkName: check.name, status: "repaired", detail: `started ${container} (${wait.detail})` };
      }
      const { breakerOpened } = state.recordFailure(key);
      return { target, checkName: check.name, status: "failed", detail: `started ${container} but ${wait.detail}${breakerOpened ? " — circuit breaker OPENED" : ""}` };
    }

    case "container-restart": {
      const container = check.repairContext?.container ?? options.containers.memoryCore;
      const res = await dockerRestart(runtime, container);
      if (res === "missing") {
        state.recordSuccess(key);
        return { target, checkName: check.name, status: "aborted", detail: `container ${container} disappeared — rerun doctor to use the recreate path` };
      }
      if (res !== "repaired") {
        const { breakerOpened } = state.recordFailure(key);
        return { target, checkName: check.name, status: "failed", detail: `docker restart ${container} failed${breakerOpened ? " — circuit breaker OPENED" : ""}` };
      }
      const wait = await waitForContainerHealthy(runtime, container);
      if (wait.ok) {
        state.recordSuccess(key);
        return { target, checkName: check.name, status: "repaired", detail: `restarted ${container} (${wait.detail})` };
      }
      const { breakerOpened } = state.recordFailure(key);
      return { target, checkName: check.name, status: "failed", detail: `restarted ${container} but ${wait.detail}${breakerOpened ? " — circuit breaker OPENED" : ""}` };
    }

    case "container-recreate": {
      const container = check.repairContext?.container ?? "";
      // Pinned-image guard: read canonical .env, refuse anything but the pinned image.
      const pinned = await (deps.readPinnedEnv ? deps.readPinnedEnv() : readPinnedImageFromEnv(options, runtime));
      if (pinned !== options.pinnedImage) {
        state.recordFailure(key);
        return {
          target,
          checkName: check.name,
          status: "aborted",
          detail: `canonical .env pins MEMORY_CORE_IMAGE=${pinned ?? "(unset)"}, expected ${options.pinnedImage} — refusing to recreate (never fall back to registry latest)`,
        };
      }
      const res = await runCanonicalStart(deps);
      if (res.ok) {
        state.recordSuccess(key);
        return { target, checkName: check.name, status: "repaired", detail: `recreated via canonical start script (${container})` };
      }
      const { breakerOpened } = state.recordFailure(key);
      return { target, checkName: check.name, status: "failed", detail: `recreate failed: ${res.detail}${breakerOpened ? " — circuit breaker OPENED" : ""}` };
    }

    case "provider-directive": {
      const providerId = check.repairContext?.providerId ?? "?";
      return {
        target,
        checkName: check.name,
        status: "aborted",
        detail: `no automatic repair — run: continuum auth ${providerId} (or continuum setup)`,
      };
    }

    case "credential-directive": {
      return {
        target,
        checkName: check.name,
        status: "aborted",
        detail: "no automatic repair — credential backend requires manual setup: continuum setup",
      };
    }

    case "stale-process-kill": {
      const pids = (check.repairContext?.pids ?? "").split(",").map((p) => p.trim()).filter((p) => /^\d+$/.test(p));
      if (pids.length === 0) {
        return { target, checkName: check.name, status: "aborted", detail: "no pids to reap" };
      }
      const res = await runtime.run("kill", pids, { timeoutMs: DOCKER_TIMEOUT_MS });
      if (res.code === 0) {
        state.recordSuccess(key);
        return { target, checkName: check.name, status: "repaired", detail: `reaped ${pids.length} orphaned process(es): ${pids.join(" ")}` };
      }
      const { breakerOpened } = state.recordFailure(key);
      return { target, checkName: check.name, status: "failed", detail: `kill failed: ${firstLine(res.stderr)}${breakerOpened ? " — circuit breaker OPENED" : ""}` };
    }
  }
}

/**
 * Run repairs for every failed check that has a strategy. Already-healthy
 * checks are never touched (no broad recreation). State persists after each
 * attempt so a crash mid-repair leaves the guards in place.
 */
export async function runRepairs(deps: RepairDeps, checks: readonly HealthCheckResult[]): Promise<readonly RepairOutcome[]> {
  const outcomes: RepairOutcome[] = [];
  // While the docker daemon itself is down, any container repair would fail
  // before it can even reach the engine. Defer them so a single `--repair`
  // pass cascades: docker restored first, containers next, gateways last.
  // Without this, gateway-level checks fire `docker start` against a dead
  // daemon, record failures, and the stack stays down until a second run.
  const dockerDown = checks.some((c) => c.name === "docker" && c.status === "down");
  for (const check of checks) {
    if (check.status === "ok" || check.status === "skipped" || !check.repair) continue;
    if (dockerDown && (check.repair === "container-start" || check.repair === "container-restart" || check.repair === "container-recreate")) {
      outcomes.push({ target: check.repair, checkName: check.name, status: "deferred", detail: "docker daemon down — deferring until Docker is restored" });
      continue;
    }
    const outcome = await repairTarget(deps, check);
    outcomes.push(outcome);
    await deps.state.persist();
  }
  return outcomes;
}
