/**
 * `LocalServiceManager` — the generic lifecycle engine for a provider's
 * managed local inference server. Provider-agnostic: it acts only on a
 * resolved `LocalServiceDescriptor`.
 *
 * `ensureRunning` contract (in order):
 *   1. A CONTINUUM-owned pid that is alive AND health-passes → reuse it.
 *   2. A stale owned-state file (dead pid) → clear it, fall through.
 *   3. The port already answers a healthy, OpenAI-compatible endpoint that
 *      CONTINUUM did NOT start → reuse it, unclaimed ("reused-foreign").
 *   4. The port answers but is NOT compatible → hard error (never kill it).
 *   5. Otherwise spawn `command + args` directly (no shell), detached, with
 *      combined output appended to a per-provider log; poll health until the
 *      descriptor's `startupTimeoutSec`. On success persist owned state; on
 *      timeout kill the just-spawned child and throw with a log tail.
 *
 * Concurrency: an in-process promise map coalesces same-process races; an
 * O_EXCL lock file coalesces cross-process races. A caller that loses the
 * lock waits and then re-checks health (the winner will have started it).
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { openSync, promises as fs } from "node:fs";
import { probeLocalService, waitForHealthy, type FetchLike } from "./health.js";
import {
  acquireStartupLock,
  clearState,
  isPidAlive,
  localServicesDir,
  logFilePath,
  readLiveState,
  readState,
  stateFilePath,
  writeState,
} from "./state.js";
import type {
  LocalServiceDescriptor,
  LocalServiceOutcome,
  LocalServiceState,
  LocalServiceStatus,
  LocalServiceStopResult,
} from "./types.js";

export class LocalServiceStartupError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    readonly logTail?: string,
  ) {
    super(message);
    this.name = "LocalServiceStartupError";
  }
}

export class LocalServicePortConflictError extends Error {
  constructor(
    readonly providerId: string,
    readonly host: string,
    readonly port: number,
    message: string,
  ) {
    super(message);
    this.name = "LocalServicePortConflictError";
  }
}

export interface SpawnedChild {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  on(event: "exit", listener: () => void): void;
  unref(): void;
}

export interface LocalServiceManagerDeps {
  readonly dataDir: string;
  /** HTTP probe implementation (defaults to global fetch). */
  readonly fetchImpl?: FetchLike;
  /** Spawn seam (defaults to node:child_process spawn, detached). */
  readonly spawn?: (descriptor: LocalServiceDescriptor, logFd: number) => SpawnedChild;
  /** Injectable sleep for the startup poll (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Progress lines ("starting Local Ornith …", "healthy after 7s"). */
  readonly onProgress?: (line: string) => void;
}

function defaultSpawn(descriptor: LocalServiceDescriptor, logFd: number): SpawnedChild {
  const child: ChildProcess = nodeSpawn(descriptor.command, [...descriptor.args], {
    cwd: descriptor.cwd,
    env: { ...process.env, ...descriptor.env },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  return child as unknown as SpawnedChild;
}

export class LocalServiceManager {
  private readonly inFlight = new Map<string, Promise<LocalServiceOutcome>>();

  constructor(private readonly deps: LocalServiceManagerDeps) {}

  private progress(line: string): void {
    this.deps.onProgress?.(line);
  }

  /** Ensure the descriptor's service is reachable+healthy; start it if needed. */
  async ensureRunning(descriptor: LocalServiceDescriptor): Promise<LocalServiceOutcome> {
    const existing = this.inFlight.get(descriptor.providerId);
    if (existing) return existing;
    const run = this.ensureRunningInner(descriptor).finally(() => {
      this.inFlight.delete(descriptor.providerId);
    });
    this.inFlight.set(descriptor.providerId, run);
    return run;
  }

  private async ensureRunningInner(descriptor: LocalServiceDescriptor): Promise<LocalServiceOutcome> {
    const { dataDir } = this.deps;

    // 1 + 2: consult our own state file.
    const live = await readLiveState(dataDir, descriptor.providerId);
    if (live.state && live.pidAlive) {
      const probe = await this.probe(descriptor);
      if (probe.healthy) {
        this.progress(`Local service for ${descriptor.providerId} already running (pid ${live.state.pid}) — reusing.`);
        return { kind: "reused-owned", state: live.state };
      }
      // Owned pid alive but not answering: it is still ours to manage, but
      // it's wedged. Do not spawn a second one onto the same port — surface it.
      throw new LocalServiceStartupError(
        descriptor.providerId,
        `${descriptor.providerId}: a CONTINUUM-managed process (pid ${live.state.pid}) is running but not answering ${this.healthUrl(descriptor)}. Run \`continuum local stop ${descriptor.providerId}\` and retry.`,
        await this.logTail(descriptor.providerId),
      );
    }
    if (live.stale) {
      this.progress(`Clearing stale local-service state for ${descriptor.providerId} (pid ${live.state?.pid} is gone).`);
      await clearState(dataDir, descriptor.providerId);
    }

    // 3 + 4: is the port already serving something?
    const preProbe = await this.probe(descriptor);
    if (preProbe.reachable) {
      if (preProbe.healthy && preProbe.compatible) {
        this.progress(`${this.healthUrl(descriptor)} already serves a compatible endpoint — reusing without claiming ownership.`);
        return { kind: "reused-foreign", host: descriptor.host, port: descriptor.port };
      }
      throw new LocalServicePortConflictError(
        descriptor.providerId,
        descriptor.host,
        descriptor.port,
        `${descriptor.host}:${descriptor.port} is occupied by a process CONTINUUM did not start and it is not a healthy OpenAI-compatible endpoint (status ${preProbe.status ?? "no response"}). CONTINUUM will not touch it — free the port or point the provider elsewhere.`,
      );
    }

    // 5: acquire the cross-process lock, then spawn.
    const release = await acquireStartupLock(dataDir, descriptor.providerId);
    if (!release) {
      // Another invocation is starting it — wait for that to land.
      this.progress(`Another CONTINUUM process is starting ${descriptor.providerId}; waiting for it to become healthy…`);
      const probe = await waitForHealthy(descriptor.host, descriptor.port, descriptor.healthPath, {
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        timeoutMs: descriptor.startupTimeoutSec * 1000,
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
        ...(this.deps.now ? { now: this.deps.now } : {}),
      });
      if (!probe.healthy) {
        throw new LocalServiceStartupError(
          descriptor.providerId,
          `${descriptor.providerId}: waited ${descriptor.startupTimeoutSec}s for a concurrent startup that never became healthy.`,
          await this.logTail(descriptor.providerId),
        );
      }
      const reread = await readState(dataDir, descriptor.providerId);
      return reread ? { kind: "reused-owned", state: reread } : { kind: "reused-foreign", host: descriptor.host, port: descriptor.port };
    }

    try {
      // Re-check under the lock: the winner of a race may have just finished.
      const underLock = await readLiveState(dataDir, descriptor.providerId);
      if (underLock.state && underLock.pidAlive && (await this.probe(descriptor)).healthy) {
        return { kind: "reused-owned", state: underLock.state };
      }
      return await this.spawnAndWait(descriptor);
    } finally {
      await release();
    }
  }

  private async spawnAndWait(descriptor: LocalServiceDescriptor): Promise<LocalServiceOutcome> {
    const { dataDir } = this.deps;
    await fs.mkdir(localServicesDir(dataDir), { recursive: true });
    const logFile = logFilePath(dataDir, descriptor.providerId);
    const logFd = openSync(logFile, "a");

    const spawnFn = this.deps.spawn ?? defaultSpawn;
    this.progress(`Starting ${descriptor.providerId}: ${descriptor.command} ${descriptor.args.join(" ")}`);
    let child: SpawnedChild;
    try {
      child = spawnFn(descriptor, logFd);
    } catch (err) {
      throw new LocalServiceStartupError(
        descriptor.providerId,
        `${descriptor.providerId}: failed to spawn ${descriptor.command}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (child.pid === undefined) {
      throw new LocalServiceStartupError(descriptor.providerId, `${descriptor.providerId}: ${descriptor.command} did not produce a pid.`);
    }
    const pid = child.pid;
    let childExited = false;
    child.on("exit", () => {
      childExited = true;
    });
    // Detach: the server must outlive the CONTINUUM chat/session that started it.
    child.unref();

    const startedAtMs = (this.deps.now ?? Date.now)();
    const probe = await waitForHealthy(descriptor.host, descriptor.port, descriptor.healthPath, {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      timeoutMs: descriptor.startupTimeoutSec * 1000,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      isChildAlive: () => !childExited && isPidAlive(pid),
    });

    if (!probe.healthy) {
      // Our own child, our own responsibility to clean up.
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      await clearState(dataDir, descriptor.providerId);
      const reason = childExited
        ? `${descriptor.command} exited before ${this.healthUrl(descriptor)} became healthy`
        : `${this.healthUrl(descriptor)} did not become healthy within ${descriptor.startupTimeoutSec}s`;
      throw new LocalServiceStartupError(descriptor.providerId, `${descriptor.providerId}: ${reason}.`, await this.logTail(descriptor.providerId));
    }

    const elapsedS = Math.round(((this.deps.now ?? Date.now)() - startedAtMs) / 1000);
    const state: LocalServiceState = {
      schemaVersion: 1,
      providerId: descriptor.providerId,
      pid,
      host: descriptor.host,
      port: descriptor.port,
      healthPath: descriptor.healthPath,
      command: descriptor.command,
      args: [...descriptor.args],
      ...(descriptor.model ? { model: descriptor.model } : {}),
      startedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
      logFile,
      ownedByContinuum: true,
    };
    await writeState(dataDir, state);
    this.progress(`${descriptor.providerId} healthy after ${elapsedS}s (pid ${pid}).`);
    return { kind: "started", state };
  }

  /** Lifecycle view for `continuum local status`. */
  async status(descriptor: LocalServiceDescriptor): Promise<LocalServiceStatus> {
    const live = await readLiveState(this.deps.dataDir, descriptor.providerId);
    const probe = await this.probe(descriptor);
    const base = {
      providerId: descriptor.providerId,
      host: descriptor.host,
      port: descriptor.port,
      healthy: probe.healthy,
      ...(descriptor.model ? { model: descriptor.model } : {}),
    };
    if (live.state && live.pidAlive) {
      return {
        ...base,
        state: probe.healthy ? "running-owned" : "unhealthy-owned",
        pid: live.state.pid,
        startedAt: live.state.startedAt,
        logFile: live.state.logFile,
        detail: probe.healthy
          ? `CONTINUUM-managed, pid ${live.state.pid}, healthy at ${this.healthUrl(descriptor)}`
          : `CONTINUUM-managed pid ${live.state.pid} is not answering ${this.healthUrl(descriptor)}`,
      };
    }
    if (probe.healthy) {
      return {
        ...base,
        state: "running-foreign",
        detail: `an endpoint CONTINUUM did not start is answering ${this.healthUrl(descriptor)}${probe.compatible ? " (OpenAI-compatible)" : " (not recognised as OpenAI-compatible)"}`,
      };
    }
    return { ...base, state: "stopped", detail: `nothing is answering ${this.healthUrl(descriptor)}` };
  }

  /** Stop ONLY a service CONTINUUM started. A foreign occupant is never signalled. */
  async stop(descriptor: LocalServiceDescriptor): Promise<LocalServiceStopResult> {
    const { dataDir } = this.deps;
    const live = await readLiveState(dataDir, descriptor.providerId);
    if (!live.state) {
      const probe = await this.probe(descriptor);
      if (probe.reachable) {
        return {
          providerId: descriptor.providerId,
          result: "not-owned",
          detail: `${descriptor.host}:${descriptor.port} is in use, but CONTINUUM has no record of starting it — left untouched.`,
        };
      }
      return { providerId: descriptor.providerId, result: "not-running", detail: `${descriptor.providerId} is not running.` };
    }
    if (!live.pidAlive) {
      await clearState(dataDir, descriptor.providerId);
      return { providerId: descriptor.providerId, result: "not-running", detail: `${descriptor.providerId} had already exited; cleared stale state.` };
    }

    const pid = live.state.pid;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* raced with exit */
    }
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < 20 && isPidAlive(pid); i++) await sleep(250);
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
      for (let i = 0; i < 8 && isPidAlive(pid); i++) await sleep(250);
    }
    await clearState(dataDir, descriptor.providerId);
    return {
      providerId: descriptor.providerId,
      result: "stopped",
      detail: `stopped ${descriptor.providerId} (pid ${pid}).`,
    };
  }

  private probe(descriptor: LocalServiceDescriptor) {
    return probeLocalService(descriptor.host, descriptor.port, descriptor.healthPath, {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  private healthUrl(descriptor: LocalServiceDescriptor): string {
    return `http://${descriptor.host}:${descriptor.port}${descriptor.healthPath}`;
  }

  private async logTail(providerId: string, bytes = 2_000): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(logFilePath(this.deps.dataDir, providerId), "utf8");
      return raw.length > bytes ? raw.slice(-bytes) : raw;
    } catch {
      return undefined;
    }
  }

  /** Path helpers exposed for `continuum local` / diagnostics. */
  stateFile(providerId: string): string {
    return stateFilePath(this.deps.dataDir, providerId);
  }
}
