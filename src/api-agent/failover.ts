import type { ToolDefinition } from "../mcp/tools.js";
import type { ProviderAdapter } from "../providers/types.js";
import { isPromoActive } from "../providers/promo.js";
import { createApiRunner, type ApiRunner, type RunnerDeps } from "./runner.js";
import { ApiAgentError, type AgentMessage, type AgentTurnResult, type NetworkFailureKind } from "./types.js";

export type CandidateHealth = "healthy" | "cooling-down" | "exhausted" | "disabled";
export type FailoverBilling = "free" | "paid";

export interface FailoverCandidate {
  readonly adapter: ProviderAdapter;
  /** Candidate-scoped auth environment. It is used to build headers and is never exposed in status. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Explicit override for tests/dynamic manifests; profile billing otherwise applies. */
  readonly billing?: FailoverBilling;
  /** A preflight/auth failure can place a candidate in the pool as disabled for deterministic reporting. */
  readonly disabledReason?: string;
  /** Test seam. Production candidates use the unchanged single-provider createApiRunner. */
  readonly runner?: ApiRunner;
  readonly runnerDeps?: Omit<RunnerDeps, "env">;
}

export interface FailoverPolicy {
  readonly mode?: "freeOnly" | "freeFirst";
  /** Required in addition to freeFirst before a paid candidate is eligible. */
  readonly allowPaidFallback?: boolean;
  readonly authFailure?: "disable-and-failover" | "fail";
  readonly cooldownMs?: number;
  readonly now?: () => number;
  readonly onSwitch?: (event: ProviderSwitchEvent) => void | Promise<void>;
}

export interface ProviderSwitchEvent {
  readonly fromProviderId: string;
  readonly fromDisplayName: string;
  readonly toProviderId: string;
  readonly toDisplayName: string;
  readonly reason: NetworkFailureKind;
}

export interface CandidateStatus {
  readonly providerId: string;
  readonly displayName: string;
  readonly billing: FailoverBilling;
  readonly health: CandidateHealth;
  readonly failureReason?: string;
  readonly retryAtMs?: number;
}

interface CandidateRuntime {
  readonly adapter: ProviderAdapter;
  readonly runner: ApiRunner;
  readonly billing: FailoverBilling;
  health: CandidateHealth;
  failureReason?: string;
  retryAtMs?: number;
}

const FAILOVER_KINDS: ReadonlySet<NetworkFailureKind> = new Set([
  "rate-limit",
  "quota-exhausted",
  "server-error",
  "timeout",
  "dns",
  "connection-refused",
]);

function billingOf(candidate: FailoverCandidate, now: number): FailoverBilling {
  const declared = candidate.billing ?? candidate.adapter.profile.billing ?? "paid";
  // A declared free promotional provider becomes paid when its authoritative
  // promo end passes. Unknown promo ends remain free, matching promo routing.
  if (declared === "free" && candidate.adapter.profile.promo && !isPromoActive(candidate.adapter.profile.promo, now)) return "paid";
  return declared;
}

function safeReason(kind: NetworkFailureKind | undefined): string {
  switch (kind) {
    case "quota-exhausted": return "quota exhausted";
    case "rate-limit": return "rate limited";
    case "server-error": return "provider outage";
    case "timeout": return "timed out";
    case "dns": return "DNS failure";
    case "connection-refused": return "connection refused";
    case "auth": return "authentication failed";
    default: return "unavailable";
  }
}

export class ApiFailoverExhaustedError extends ApiAgentError {
  readonly candidates: readonly CandidateStatus[];

  constructor(candidates: readonly CandidateStatus[]) {
    const summary = candidates
      .map((candidate) => `${candidate.displayName}: ${candidate.health}${candidate.failureReason ? ` (${candidate.failureReason})` : ""}`)
      .join("; ");
    super(`API provider pool exhausted — ${summary}. Configure another free API provider or explicitly enable paid fallback.`, {
      retryable: false,
    });
    this.name = "ApiFailoverExhaustedError";
    this.candidates = candidates;
  }
}

export interface FailoverApiRunner extends ApiRunner {
  activeProviderId(): string | undefined;
  status(): readonly CandidateStatus[];
}

/**
 * Composite runner for one logical agent loop. It retries an unchanged
 * messages/tools snapshot across provider candidates; only runAgentLoop may
 * append a successful assistant turn or execute tools.
 */
export function createFailoverApiRunner(candidates: readonly FailoverCandidate[], policy: FailoverPolicy = {}): FailoverApiRunner {
  const now = policy.now ?? (() => Date.now());
  const cooldownMs = policy.cooldownMs ?? 30_000;
  const mode = policy.mode ?? "freeOnly";
  const allowPaid = mode === "freeFirst" && policy.allowPaidFallback === true;
  const authFailure = policy.authFailure ?? "disable-and-failover";
  const runtimes: CandidateRuntime[] = candidates.map((candidate) => ({
    adapter: candidate.adapter,
    runner: candidate.runner ?? createApiRunner(candidate.adapter, { ...candidate.runnerDeps, env: candidate.env }),
    billing: billingOf(candidate, now()),
    health: candidate.disabledReason ? "disabled" : "healthy",
    ...(candidate.disabledReason ? { failureReason: candidate.disabledReason } : {}),
  }));
  let activeIndex: number | undefined;

  function refresh(runtime: CandidateRuntime): void {
    if ((runtime.health === "cooling-down" || runtime.health === "exhausted") && runtime.retryAtMs !== undefined && runtime.retryAtMs <= now()) {
      runtime.health = "healthy";
      runtime.failureReason = undefined;
      runtime.retryAtMs = undefined;
    }
  }

  function status(): readonly CandidateStatus[] {
    return runtimes.map((runtime) => {
      refresh(runtime);
      const paidBlocked = runtime.billing === "paid" && !allowPaid;
      return {
        providerId: runtime.adapter.profile.id,
        displayName: runtime.adapter.profile.displayName,
        billing: runtime.billing,
        health: paidBlocked && runtime.health === "healthy" ? "disabled" : runtime.health,
        ...(paidBlocked && runtime.health === "healthy"
          ? { failureReason: "paid fallback not enabled" }
          : runtime.failureReason
            ? { failureReason: runtime.failureReason }
            : {}),
        ...(runtime.retryAtMs !== undefined ? { retryAtMs: runtime.retryAtMs } : {}),
      };
    });
  }

  function eligible(index: number, tools: readonly ToolDefinition[]): boolean {
    const runtime = runtimes[index]!;
    refresh(runtime);
    if (runtime.health !== "healthy") return false;
    if (runtime.billing === "paid" && !allowPaid) return false;
    if (tools.length > 0 && !runtime.adapter.getCapabilities().tools) return false;
    return true;
  }

  function nextEligible(from: number, tools: readonly ToolDefinition[], attempted: ReadonlySet<number>): number | undefined {
    for (let offset = 0; offset < runtimes.length; offset++) {
      const index = (from + offset) % runtimes.length;
      if (!attempted.has(index) && eligible(index, tools)) return index;
    }
    return undefined;
  }

  function markFailed(runtime: CandidateRuntime, err: ApiAgentError): void {
    runtime.failureReason = safeReason(err.kind);
    if (err.kind === "quota-exhausted") {
      runtime.health = "exhausted";
      // No reset information means "do not retry during this process". A
      // guessed short cooldown would repeatedly spend requests against a
      // known-empty quota.
      runtime.retryAtMs = err.retryAtMs;
      return;
    }
    runtime.health = "cooling-down";
    runtime.retryAtMs = err.retryAtMs ?? now() + cooldownMs;
  }

  async function call(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): Promise<AgentTurnResult> {
    if (tools.length > 0) {
      for (const runtime of runtimes) {
        if (runtime.health === "healthy" && !runtime.adapter.getCapabilities().tools) {
          runtime.health = "disabled";
          runtime.failureReason = "required tool calling unsupported";
        }
      }
    }
    const attempted = new Set<number>();
    let index = nextEligible(activeIndex ?? 0, tools, attempted);
    if (index === undefined) throw new ApiFailoverExhaustedError(status());

    for (;;) {
      const runtime = runtimes[index]!;
      attempted.add(index);
      activeIndex = index;
      try {
        return await runtime.runner.call(messages, tools);
      } catch (error) {
        if (!(error instanceof ApiAgentError)) throw error;
        if (error.kind === "auth") {
          if (authFailure === "fail") throw error;
          runtime.health = "disabled";
          runtime.failureReason = safeReason(error.kind);
          runtime.retryAtMs = undefined;
        } else if (error.kind && FAILOVER_KINDS.has(error.kind)) {
          markFailed(runtime, error);
        } else {
          // TLS and malformed/config/payload 4xx errors are intentionally not
          // cycled across the pool: the same request is likely invalid there too.
          throw error;
        }

        const next = nextEligible((index + 1) % runtimes.length, tools, attempted);
        if (next === undefined) throw new ApiFailoverExhaustedError(status());
        const replacement = runtimes[next]!;
        try {
          await policy.onSwitch?.({
            fromProviderId: runtime.adapter.profile.id,
            fromDisplayName: runtime.adapter.profile.displayName,
            toProviderId: replacement.adapter.profile.id,
            toDisplayName: replacement.adapter.profile.displayName,
            reason: error.kind!,
          });
        } catch {
          // Status/telemetry hooks must never prevent the already-selected
          // replacement from receiving the unchanged call.
        }
        index = next;
      }
    }
  }

  return {
    call,
    activeProviderId: () => activeIndex === undefined ? undefined : runtimes[activeIndex]?.adapter.profile.id,
    status,
  };
}
