/**
 * Lifecycle management for the local DeepSeek compatibility proxy (the
 * schema-sanitizing boundary declared by a launch descriptor's `compatProxy`
 * spec — see deepseek-proxy.ts / deepseek-schema-sanitizer.ts).
 *
 * `makeEnsureCompatProxy` returns an ensure function the launcher calls
 * BEFORE spawning a Claude Code session whose launch descriptor declares a
 * compat proxy:
 *
 *  1. Probe the loopback health path. A listener that answers with the
 *     expected service identity AND upstream is REUSED (an existing healthy
 *     proxy is never duplicated).
 *  2. Otherwise spawn `node <scriptPath> --port <port> --upstream <upstream>`
 *     (detached, stdio ignored — survives the launcher's own exit, exactly
 *     like the desktop launcher's instance) and poll health for a bounded
 *     window.
 *  3. If the proxy cannot be started — script missing, port held by a
 *     foreign service that fails the identity check, or health never
 *     reached — return a not-ready result with a clear detail. The launcher
 *     turns that into a hard launch error: falling back to the direct
 *     DeepSeek endpoint would reintroduce the known Artifact-schema
 *     HTTP 400, so a silent fallback is deliberately impossible.
 *
 * No credentials ever enter the spawn arguments, environment, or health
 * URLs: the proxy forwards the CLI's own auth headers and stores nothing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompatProxySpec } from "./types.js";

export interface CompatProxyReadiness {
  readonly ready: boolean;
  /** "reuse" = an already-healthy proxy was found; "spawned" = started now. */
  readonly kind?: "reuse" | "spawned";
  /** Secret-free explanation when `ready` is false. */
  readonly detail?: string;
}

export interface HealthProbe {
  readonly ok: boolean;
  readonly serviceId?: string;
  readonly upstream?: string;
}

export interface EnsureCompatProxyOptions {
  /** Health probe seam (default: real HTTP GET on the loopback health path). */
  readonly healthCheck?: (healthUrl: string, timeoutMs: number) => Promise<HealthProbe>;
  /** Spawn seam (default: detached `node <script> --port … --upstream …`). */
  readonly spawnProxy?: (command: string, args: readonly string[], state: SpawnState) => void;
  /** Resolve the spec's relative `scriptPath` to an absolute path (default: package root from this module's location). */
  readonly resolveScriptPath?: (spec: CompatProxySpec) => string;
  /** Package root used by the default `resolveScriptPath` (default: derived from import.meta.url). */
  readonly packageRoot?: string;
  readonly healthTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Total window to wait for a freshly spawned proxy to become healthy. */
  readonly startWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Mutable spawn outcome shared between the spawn seam and the poll loop. */
export interface SpawnState {
  error?: string;
  exitCode?: number | null;
  /** Bounded stderr tail of a quickly-dying child — used for a precise failure detail. */
  stderrTail?: string;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_START_WAIT_MS = 6000;

export function makeEnsureCompatProxy(
  options: EnsureCompatProxyOptions = {},
): (spec: CompatProxySpec, onProgress?: (line: string) => void) => Promise<CompatProxyReadiness> {
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const spawnProxy = options.spawnProxy ?? defaultSpawnProxy;
  const resolveScriptPath = options.resolveScriptPath ?? ((spec) => defaultResolveScriptPath(spec, options.packageRoot));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startWaitMs = options.startWaitMs ?? DEFAULT_START_WAIT_MS;

  return async (spec, onProgress) => {
    const healthUrl = `http://${spec.host}:${spec.port}${spec.healthPath}`;

    // 1) Reuse: a healthy, provably-ours listener is never duplicated.
    const existing = await healthCheck(healthUrl, healthTimeoutMs);
    if (isHealthyProxy(existing, spec)) {
      onProgress?.(`DeepSeek compatibility proxy already healthy on http://${spec.host}:${spec.port}.`);
      return { ready: true, kind: "reuse" };
    }
    // A listener that answers but fails the identity/upstream proof is NOT
    // ours — refuse to route Claude Code (and its auth headers) through it.
    if (existing.ok) {
      return {
        ready: false,
        detail:
          `something else is answering on http://${spec.host}:${spec.port}${spec.healthPath} and did not prove it is this proxy ` +
          `(expected service "${spec.serviceId}", upstream "${spec.upstreamBaseUrl}"); refusing to route a Claude Code session through an unknown listener.`,
      };
    }

    // 2) Start it.
    const script = resolveScriptPath(spec);
    const args = [script, "--port", String(spec.port), "--upstream", spec.upstreamBaseUrl];
    const state: SpawnState = {};
    spawnProxy(process.execPath, args, state);
    if (state.error) {
      return { ready: false, detail: `could not start the DeepSeek compatibility proxy (${script}): ${state.error}` };
    }
    onProgress?.(`Started DeepSeek compatibility proxy on http://${spec.host}:${spec.port} → ${spec.upstreamBaseUrl}.`);

    // 3) Poll until healthy (bounded).
    const deadline = Date.now() + startWaitMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      if (state.error) {
        return { ready: false, detail: `the DeepSeek compatibility proxy failed to start: ${state.error}` };
      }
      if (state.exitCode !== undefined && state.exitCode !== null) {
        const tail = state.stderrTail?.trim() ? `: ${state.stderrTail.trim().split("\n").slice(-2).join(" ")}` : "";
        return { ready: false, detail: `the DeepSeek compatibility proxy exited immediately with code ${state.exitCode}${tail}` };
      }
      const probe = await healthCheck(healthUrl, healthTimeoutMs);
      if (isHealthyProxy(probe, spec)) {
        return { ready: true, kind: "spawned" };
      }
    }
    return {
      ready: false,
      detail: `the DeepSeek compatibility proxy did not become healthy on ${healthUrl} within ${startWaitMs}ms (script: ${script}).`,
    };
  };
}

function isHealthyProxy(probe: HealthProbe, spec: CompatProxySpec): boolean {
  return probe.ok === true && probe.serviceId === spec.serviceId && (probe.upstream === undefined || probe.upstream === spec.upstreamBaseUrl);
}

async function defaultHealthCheck(url: string, timeoutMs: number): Promise<HealthProbe> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { ok?: unknown; service?: unknown; upstream?: unknown };
    return {
      ok: body.ok === true,
      serviceId: typeof body.service === "string" ? body.service : undefined,
      upstream: typeof body.upstream === "string" ? body.upstream : undefined,
    };
  } catch {
    return { ok: false };
  }
}

function defaultSpawnProxy(command: string, args: readonly string[], state: SpawnState): void {
  let child: ChildProcess;
  try {
    // Detached + unref: the proxy outlives the launcher process (Claude Code
    // sessions keep running after `continuum` exits). stderr is piped (bounded
    // tail only) so a quickly-dying child yields a precise failure detail
    // instead of a guessed one; stdout is ignored so the proxy never competes
    // with the CLI for the terminal. `args` are the proxy script + --port +
    // --upstream only — never credentials.
    child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    return;
  }
  let tail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-1000);
  });
  // The stderr pipe must not keep the launcher's event loop alive once the
  // ensure window is over — unref it alongside the child, so a parent with no
  // other work exits while the detached proxy keeps serving. (The proxy
  // writes to stderr only when it is already dying, so an EPIPE after the
  // parent exits is harmless.)
  (child.stderr as unknown as { unref?: () => void } | undefined)?.unref?.();
  child.once("error", (err) => {
    state.error = err.message;
  });
  child.once("exit", (code) => {
    state.exitCode = code;
    if (tail.length > 0) state.stderrTail = tail;
  });
  child.unref();
}

/**
 * The proxy entry script is colocated with this module in the built package
 * (dist/providers/), so the manifest's `scriptPath` (e.g.
 * "providers/deepseek-proxy-bin.js") resolves to THIS module's directory +
 * its basename — correct in both the built dist layout and the source tree.
 */
function defaultResolveScriptPath(spec: CompatProxySpec, packageRoot?: string): string {
  const root = packageRoot ?? dirname(fileURLToPath(import.meta.url));
  return join(root, spec.scriptPath.split("/").pop() ?? spec.scriptPath);
}
