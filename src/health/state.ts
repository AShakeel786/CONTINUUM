/**
 * Cooldown + circuit-breaker state for recovery.
 *
 * Two guards keep `doctor --repair` bounded:
 *   - COOLDOWN: a minimum interval between repair attempts per target, so a
 *     stuck repair can't hammer the stack;
 *   - CIRCUIT BREAKER: after N consecutive failed attempts on a target the
 *     breaker opens for a fixed window; further repairs are skipped with an
 *     explicit "breaker open until <time>" outcome.
 *
 * State is persisted atomically to `options.stateFile` (same atomic-write
 * primitive the session store uses) so the guards survive process restarts.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson, fileExists, readJsonWithRecovery } from "../session/atomic-file.js";
import type { RecoveryPolicy } from "./types.js";

interface TargetState {
  readonly lastAttemptMs: number;
  readonly consecutiveFailures: number;
  readonly openUntilMs: number;
}

interface PersistedState {
  readonly targets: Record<string, TargetState>;
  /**
   * True once the Tencent stack's containers were observed on some prior
   * launch/doctor pass. Survives the engine going down, so a later stopped-
   * engine launch still knows the stack is deployed and arms the
   * docker-desktop repair (the daemon is what must be started — detection via
   * `docker ps` can't see containers through a stopped engine).
   */
  readonly stackSeen?: boolean;
}

const EMPTY_TARGET: TargetState = { lastAttemptMs: 0, consecutiveFailures: 0, openUntilMs: 0 };

export class RecoveryState {
  private targets = new Map<string, TargetState>();
  private stackSeenFlag = false;

  constructor(
    private readonly stateFile: string,
    private readonly policy: RecoveryPolicy,
    private readonly now: () => number,
  ) {}

  /** Load persisted state; corrupt/missing files degrade to empty state. */
  async load(): Promise<void> {
    if (!this.stateFile) return;
    try {
      if (!(await fileExists(this.stateFile))) return;
      const { data } = await readJsonWithRecovery<PersistedState>(this.stateFile);
      if (data && typeof data === "object" && data.targets && typeof data.targets === "object") {
        for (const [key, value] of Object.entries(data.targets)) {
          const v = value as Partial<TargetState>;
          this.targets.set(key, {
            lastAttemptMs: typeof v.lastAttemptMs === "number" ? v.lastAttemptMs : 0,
            consecutiveFailures: typeof v.consecutiveFailures === "number" ? v.consecutiveFailures : 0,
            openUntilMs: typeof v.openUntilMs === "number" ? v.openUntilMs : 0,
          });
        }
      }
      if (typeof data?.stackSeen === "boolean") this.stackSeenFlag = data.stackSeen;
    } catch {
      // Unreadable state file is not an error worth failing repair over.
    }
  }

  async persist(): Promise<void> {
    if (!this.stateFile) return;
    const data: PersistedState = {
      targets: Object.fromEntries(this.targets),
      ...(this.stackSeenFlag ? { stackSeen: true } : {}),
    };
    mkdirSync(dirname(this.stateFile), { recursive: true });
    await atomicWriteJson(this.stateFile, data);
  }

  /** True when the Tencent stack's containers were observed previously. */
  stackSeen(): boolean {
    return this.stackSeenFlag;
  }

  markStackSeen(): void {
    this.stackSeenFlag = true;
  }

  clearStackSeen(): void {
    this.stackSeenFlag = false;
  }

  private target(key: string): TargetState {
    return this.targets.get(key) ?? EMPTY_TARGET;
  }

  /**
   * Decide whether a repair attempt is allowed. Returns a rejection reason
   * (cooldown / breaker-open) or undefined when the attempt may proceed.
   */
  canAttempt(key: string): { allowed: true } | { allowed: false; reason: "cooldown" | "breaker-open"; openUntilMs?: number } {
    const t = this.target(key);
    const nowMs = this.now();
    if (t.openUntilMs > nowMs) {
      return { allowed: false, reason: "breaker-open", openUntilMs: t.openUntilMs };
    }
    if (nowMs - t.lastAttemptMs < this.policy.cooldownMs) {
      return { allowed: false, reason: "cooldown" };
    }
    return { allowed: true };
  }

  recordAttempt(key: string): void {
    const t = this.target(key);
    this.targets.set(key, { ...t, lastAttemptMs: this.now() });
  }

  recordSuccess(key: string): void {
    const t = this.target(key);
    this.targets.set(key, { lastAttemptMs: this.now(), consecutiveFailures: 0, openUntilMs: 0 });
  }

  recordFailure(key: string): { breakerOpened: boolean } {
    const t = this.target(key);
    const failures = t.consecutiveFailures + 1;
    if (failures >= this.policy.breakerFailureThreshold) {
      this.targets.set(key, {
        lastAttemptMs: this.now(),
        consecutiveFailures: failures,
        openUntilMs: this.now() + this.policy.breakerOpenMs,
      });
      return { breakerOpened: true };
    }
    this.targets.set(key, { ...t, lastAttemptMs: this.now(), consecutiveFailures: failures });
    return { breakerOpened: false };
  }
}
