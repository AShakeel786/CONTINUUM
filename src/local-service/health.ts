/**
 * Local-service health probing. Two questions, both answered over plain HTTP:
 *
 *   1. is *something* answering on host:port at all? (liveness)
 *   2. does the health endpoint return a 2xx that looks like an
 *      OpenAI-compatible model list? (compatibility — safe to reuse)
 *
 * A compatible endpoint is reusable whether or not CONTINUUM started it. An
 * occupied-but-incompatible port is an error the caller must surface — never
 * a signal to kill the occupant.
 */

export interface ProbeResult {
  /** A TCP connection was accepted and an HTTP response came back. */
  readonly reachable: boolean;
  /** The health endpoint returned a 2xx. */
  readonly healthy: boolean;
  /** The 2xx body looks like an OpenAI-compatible `{ "object": "list", "data": [...] }`. */
  readonly compatible: boolean;
  /** Raw status code, when a response was received. */
  readonly status?: number;
}

export type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

function looksCompatible(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { object?: unknown; data?: unknown };
    if (Array.isArray(parsed.data)) return true;
    if (parsed.object === "list") return true;
    return false;
  } catch {
    return false;
  }
}

/** One health probe against `http://<host>:<port><healthPath>`. Never throws. */
export async function probeLocalService(
  host: string,
  port: number,
  healthPath: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `http://${host}:${port}${healthPath.startsWith("/") ? healthPath : `/${healthPath}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "";
    }
    return {
      reachable: true,
      healthy: res.ok,
      compatible: res.ok && looksCompatible(body),
      status: res.status,
    };
  } catch {
    return { reachable: false, healthy: false, compatible: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll `probeLocalService` until it is healthy or the deadline passes.
 * Returns the last probe result. Injectable sleep for tests.
 */
export async function waitForHealthy(
  host: string,
  port: number,
  healthPath: string,
  opts: {
    fetchImpl?: FetchLike;
    timeoutMs: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Called if the spawned process exits before the endpoint becomes healthy. */
    isChildAlive?: () => boolean;
  },
): Promise<ProbeResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? 500;
  const deadline = now() + opts.timeoutMs;
  let last: ProbeResult = { reachable: false, healthy: false, compatible: false };
  while (now() < deadline) {
    last = await probeLocalService(host, port, healthPath, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      timeoutMs: Math.min(interval * 2, 3_000),
    });
    if (last.healthy) return last;
    if (opts.isChildAlive && !opts.isChildAlive()) return last;
    await sleep(interval);
  }
  return last;
}
