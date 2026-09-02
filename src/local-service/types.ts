/**
 * Managed local-service lifecycle — the provider-agnostic contract for a
 * long-running local inference server (e.g. an `mlx_lm` / `llama.cpp` /
 * `vllm` OpenAI-compatible endpoint) that CONTINUUM can health-check, start
 * on demand, reuse, and stop.
 *
 * This module owns NO provider-specific knowledge. A provider manifest
 * declares a `localService` block (see providers/manifest.ts); the manifest
 * layer resolves it into a `LocalServiceDescriptor` with every placeholder
 * substituted, and this subsystem operates purely on that descriptor.
 *
 * Security posture:
 *   - the server is spawned as executable + argv (never a shell string);
 *   - it binds a host the descriptor names (localhost by default);
 *   - CONTINUUM only ever stops a service it started itself (tracked by a
 *     persisted state file under the data dir) — a foreign process that
 *     merely happens to hold the port is never signalled;
 *   - the service is deliberately detached, so it keeps running after the
 *     CONTINUUM chat/session that started it exits.
 */

/** A fully-resolved local-service spec (all placeholders already substituted). */
export interface LocalServiceDescriptor {
  /** The provider this service backs — the key for its state/log/lock files. */
  readonly providerId: string;
  /** Executable to spawn. Absolute path or a PATH-resolvable name. */
  readonly command: string;
  /** Arguments passed verbatim to the executable (no shell, no word-splitting). */
  readonly args: readonly string[];
  /** Host the server binds AND the host CONTINUUM probes. Defaults to 127.0.0.1. */
  readonly host: string;
  /** Port the server listens on / is probed on. */
  readonly port: number;
  /**
   * Health path appended to `http://<host>:<port>` for the readiness probe.
   * For an OpenAI-compatible server this is `/v1/models`. A 2xx that also
   * looks like a model list marks the endpoint "compatible" (reusable).
   */
  readonly healthPath: string;
  /** Seconds to wait for the health probe to pass after a fresh spawn. */
  readonly startupTimeoutSec: number;
  /** Working directory for the spawned process (optional). */
  readonly cwd?: string;
  /** Extra non-secret environment for the spawned process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Model id/path the server was told to load (informational; recorded in state). */
  readonly model?: string;
}

/** Persisted record of a service CONTINUUM started. Lives at `<dataDir>/local-services/<providerId>.json`. */
export interface LocalServiceState {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly healthPath: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly model?: string;
  readonly startedAt: string;
  /** Absolute path of the combined stdout/stderr log for the spawned server. */
  readonly logFile: string;
  /** Always true — a state file only exists for a CONTINUUM-owned process. */
  readonly ownedByContinuum: true;
}

/** How `ensureRunning` satisfied the request. */
export type LocalServiceOutcome =
  /** A CONTINUUM-owned process was already healthy and was reused. */
  | { readonly kind: "reused-owned"; readonly state: LocalServiceState }
  /**
   * The port was already serving a healthy, OpenAI-compatible endpoint that
   * CONTINUUM did not start. It is reused as-is and NOT claimed as owned.
   */
  | { readonly kind: "reused-foreign"; readonly host: string; readonly port: number }
  /** A fresh server was spawned and became healthy within the timeout. */
  | { readonly kind: "started"; readonly state: LocalServiceState };

/** Current lifecycle view for `continuum local status`. */
export interface LocalServiceStatus {
  readonly providerId: string;
  readonly host: string;
  readonly port: number;
  /** "running-owned" | "running-foreign" | "stopped" | "unhealthy-owned" */
  readonly state: "running-owned" | "running-foreign" | "stopped" | "unhealthy-owned";
  readonly healthy: boolean;
  readonly pid?: number;
  readonly model?: string;
  readonly startedAt?: string;
  readonly logFile?: string;
  /** A one-line human explanation. */
  readonly detail: string;
}

export interface LocalServiceStopResult {
  readonly providerId: string;
  /** "stopped" — CONTINUUM signalled its own process and it exited.
   *  "not-owned" — something is on the port but CONTINUUM did not start it (left untouched).
   *  "not-running" — nothing to stop. */
  readonly result: "stopped" | "not-owned" | "not-running";
  readonly detail: string;
}
