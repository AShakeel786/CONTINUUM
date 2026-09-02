/**
 * `continuum launch [<project>] [--provider <id>] [--task "<goal>"]`
 * and `continuum resume <sessionId>` and `continuum handoff <sessionId>`.
 *
 * Launch resolves project → provider → session, prepares a plan (auth env,
 * session identity, context, stale check), then spawns the provider CLI with
 * inherited stdio. Handoff asks which authenticated agent takes over — never
 * auto-selects — and re-runs the same prepare→spawn flow against the chosen
 * provider, preserving the same TaskSession.
 */

import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { spawnCli } from "../../launcher/spawn.js";
import { classifyCliFailure } from "../../launcher/cli-failure.js";
import { LocalDependencyUnavailableError, LocalServiceUnavailableError, ModelUnavailableError, NoAuthenticatedAgentError, NoProjectError, ProviderNotAuthenticatedError } from "../../launcher/errors.js";
import { listRecentSessions } from "../../launcher/session-list.js";
import { suggestHandoffOnPeakEvent } from "../../pricing/handoff-suggestion.js";
import type { Launcher } from "../../launcher/launcher.js";
import type { LaunchPreparation } from "../../launcher/types.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { PricingAwarenessService } from "../../pricing/service.js";
import type { HandoffManager } from "../../handoff/manager.js";
import type { SessionManager } from "../../session/manager.js";
import type { CliIo } from "../index.js";
import { ToolResultCache } from "../../tool-cache/tool-cache.js";
import { makeScopeProvider } from "../../tool-cache/scope.js";
import { buildLauncherContext } from "./launcher-context.js";
import { DEFAULT_OPTIONS, DEFAULT_POLICY, liveRuntime, scanStaleProviderProcesses } from "../../health/adapters.js";
import { ensureLaunchStackHealthy } from "../../health/launch-heal.js";
import { ConfigStore } from "../../config/store.js";
import { ensureMcpRegistered } from "../../mcp/registration.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { buildToolRegistry } from "../../mcp/build.js";
import { runApiAgent } from "../../api-agent/run.js";
import { MemoryRawOutputStore } from "../../tool-output/store.js";
import { runInteractiveApiSession } from "../../api-agent/interactive.js";
import { telemetryOneLine } from "../../api-agent/telemetry.js";
import { createReplIo } from "../repl-io.js";
import { LocalServiceManager } from "../../local-service/manager.js";
import { resolveLocalServiceDescriptor } from "../../local-service/descriptor.js";
import { ApiAgentError, type NetworkFailureKind } from "../../api-agent/types.js";
import { ApiFailoverExhaustedError, createFailoverApiRunner, type FailoverPolicy } from "../../api-agent/failover.js";
import { isPoolFreeEligible } from "../../providers/billing.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveDataDir } from "../../config/paths.js";
import { getTerminalColumns, isStdinTty } from "./common.js";
import { buildHudData, formatTerminalTitle, printHud, printProviderIdentity } from "./hud.js";
import { CostTelemetryStore } from "../../cost/telemetry.js";
import { estimateCostUsd, DEFAULT_ROLLOVER_POLICY, evaluateRollover } from "../../cost/calculator.js";
import { nativeSessionFile, readClaudeTurns, readClaudeUsage } from "../../cost/native-usage.js";

/**
 * Launch-time stack readiness (docker/containers/gateways/processes).
 * Diagnoses the runtime stack and, when the user opted into the Tencent
 * memory stack and a recoverable check is down, runs the EXISTING bounded
 * `continuum doctor --repair` cascade before the agent starts — so a normal
 * desktop/session launch self-heals instead of silently degrading. Post-
 * repair state is what reaches the launch plan; a genuine, unrecoverable
 * failure prints one concise degraded-mode line. Never blocks a launch.
 *
 * Deliberately excludes provider/credential probes — those live in
 * `continuum doctor`, and launch already enforces auth via prepareLaunch.
 */
export async function runLaunchPreflight(
  memoryCoreConfigured = DEFAULT_OPTIONS.tencentConfigured,
  onProgress?: (line: string) => void,
): Promise<readonly string[]> {
  try {
    const result = await ensureLaunchStackHealthy({
      runtime: liveRuntime,
      options: {
        ...DEFAULT_OPTIONS,
        stateFile: join(resolveDataDir(), "health-state.json"),
        tencentConfigured: memoryCoreConfigured,
      },
      policy: { ...DEFAULT_POLICY },
      staleProcesses: async () => scanStaleProviderProcesses([...DEFAULT_OPTIONS.providerExecutables]),
      ...(onProgress ? { onProgress } : {}),
    });
    return result.warnings;
  } catch {
    return [];
  }
}

function opt(args: readonly string[], ...flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]!) && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function apiFailoverPolicyFromArgs(args: readonly string[]): FailoverPolicy {
  const allowPaidFallback = args.includes("--allow-paid-fallback");
  return {
    mode: args.includes("--free-first") || allowPaidFallback ? "freeFirst" : "freeOnly",
    allowPaidFallback,
  };
}

function failoverReason(kind: NetworkFailureKind): string {
  if (kind === "quota-exhausted") return "quota exhausted";
  if (kind === "rate-limit") return "rate limited";
  if (kind === "server-error") return "provider outage";
  if (kind === "connection-refused") return "connection refused";
  return kind;
}

function printPeakProWarning(out: (s: string) => void, prep: LaunchPreparation, pricing: PricingAwarenessService): void {
  const peak = pricing.status(prep.providerRef.providerId);
  if (prep.providerRef.model !== "deepseek-v4-pro" || peak?.tier !== "peak") return;
  const end = peak.endsAt ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(peak.endsAt) : "unknown";
  out(`⚠️  Pro is selected during DeepSeek peak pricing (${peak.multiplier}×), ending ${end} local. Confirm this escalation is necessary before continuing.\n`);
}

/**
 * Concise visible permission/model state before a launch. Full access is shown
 * ONLY when the launch actually carries the native bypass flag (never a bare
 * "bypass requested" claim); a requested-but-unavailable bypass and a model
 * fallback surface as notes, never silently.
 */
export function printPermissionState(out: (s: string) => void, prep: LaunchPreparation): void {
  if (prep.plan.bypassPermissions) {
    out(`⚡ FULL ACCESS: ${prep.providerRef.providerId} will run with tool approvals bypassed.\n`);
  }
  if (prep.permissionNote) out(`ℹ️  ${prep.permissionNote}\n`);
  if (prep.modelNote) out(`ℹ️  ${prep.modelNote}\n`);
}

async function recordLaunchDecisions(prep: LaunchPreparation, dataDir: string, pricing: PricingAwarenessService): Promise<void> {
  if (!prep.session) return;
  const store = new CostTelemetryStore(dataDir);
  const peak = pricing.status(prep.providerRef.providerId);
  if (prep.modelDecision) await store.append({ schemaVersion: 1, at: new Date().toISOString(), logicalSessionId: prep.session.sessionId, providerId: prep.providerRef.providerId, model: prep.providerRef.model, kind: "model-tier", estimate: true, peak: peak?.tier === "peak", multiplier: peak?.multiplier ?? 1, reason: prep.modelDecision.reason });
  if (prep.rollover) await store.append({ schemaVersion: 1, at: new Date().toISOString(), logicalSessionId: prep.session.sessionId, nativeSessionId: prep.rollover.toNativeSessionId, providerId: prep.providerRef.providerId, model: prep.providerRef.model, kind: "rollover", estimate: true, peak: peak?.tier === "peak", multiplier: peak?.multiplier ?? 1, reason: prep.rollover.reason, estimatedCostAvoidedUsd: prep.rollover.estimatedCostAvoidedUsd });
}

/**
 * Checks the session's active-provider pricing schedule; for any peak event,
 * surfaces a handoff suggestion (message + available authenticated agents)
 * as printable lines. Never auto-selects or auto-handsoff — it only prints
 * the choice a human then makes via `continuum handoff`.
 */
export async function checkPricing(
  sessionId: string,
  pricing: PricingAwarenessService,
  handoffManager: HandoffManager,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const { events } = await pricing.check(sessionId);
    for (const ev of events) {
      const suggestion = suggestHandoffOnPeakEvent(ev, handoffManager);
      if (!suggestion) continue;
      lines.push(`💲 ${suggestion.message}\n`);
      lines.push(`   Hand off to (still in your control): ${suggestion.availableProviders.map((p) => p.providerId).join(", ")}\n`);
    }
  } catch {
    // Pricing check is advisory; a failure here must never block a launch.
  }
  return lines;
}

/**
 * After a successful (or interrupted) spawn, best-effort capture the
 * provider's most-recent native session id and persist it against the
 * CONTINUUM session. Never throws — a failed capture just means the next
 * resume falls back to the resume brief.
 */
export function needsNativeSessionCapture(launcher: Launcher, prep: LaunchPreparation): boolean {
  // A resume already has the authoritative provider-native id. Scanning the
  // store again can select an unrelated concurrently-created conversation and
  // corrupt the logical session's bridge.
  return !!prep.session && !prep.nativeResume && !launcher.supportsDeterministicSessionId(prep.providerRef.providerId);
}

async function recordNativeSessionAfterLaunch(launcher: Launcher, prep: LaunchPreparation, startedAtMs: number): Promise<boolean> {
  if (!prep.session) return true;
  if (prep.nativeResume) return true;
  // Deterministic providers (Claude/DeepSeek) already recorded their id in
  // prepareLaunch — no store-scan needed (and it could pick the wrong file).
  if (launcher.supportsDeterministicSessionId(prep.providerRef.providerId)) return true;
  const id = await launcher.captureNativeSessionId(prep.providerRef.providerId, startedAtMs);
  if (!id) return false;
  await launcher.recordNativeSessionId(prep.session.sessionId, prep.providerRef.providerId, id);
  return true;
}

/**
 * Final API-agent failure report — provider, endpoint, local-vs-external,
 * exact classification, recovery attempts, and next actionable step. Built
 * entirely from `ApiAgentError`'s own fields, which never carry secrets
 * (auth headers/keys are never part of `.message`/`.host`).
 */
function formatApiAgentFailure(providerLabel: string, err: ApiAgentError): string {
  const host = err.host ?? "unknown host";
  const local = err.host ? /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(err.host) : false;
  const nextStep =
    err.kind === "auth"
      ? "Re-authenticate this provider and retry."
      : err.kind === "tls"
        ? "Check the provider's base URL/certificate configuration and retry."
        : err.kind === "http-error"
          ? "Check the provider configuration (base URL/model) and retry."
          : local
            ? "Check whether the local service is running (`continuum doctor`) and retry."
            : "Check your network connection and retry.";
  return (
    `✗ ${providerLabel} API connection failed\n` +
    `  endpoint: ${host} (${local ? "local" : "external"})\n` +
    `  failure: ${err.kind ?? "unknown"}${err.attempts ? ` after ${err.attempts} attempt(s)` : ""}\n` +
    `  ${err.message}\n` +
    `  next: ${nextStep}\n`
  );
}

/**
 * Next usable CLI-runtime fallback after a chain-routed native provider
 * failed. API-runtime candidates are handled inside createFailoverApiRunner.
 */
async function nextAutomaticFallback(
  ctx: { launcher: Launcher; providers: ProviderRegistry; apiFailoverPolicy?: FailoverPolicy },
  current: LaunchPreparation,
): Promise<{ providerId: string; index: number } | undefined> {
  const route = current.autoRoute!;
  for (let i = route.index + 1; i < route.chain.length; i++) {
    const id = route.chain[i]!;
    if (!ctx.providers.has(id)) continue;
    const adapter = ctx.providers.get(id);
    // Same free-only-pool gate as the failover runner and the launcher picker:
    // only `free` class AND pool-eligible providers auto-fallback; trial/paid
    // and free providers whose hard-stop free tier is not proven require the
    // explicit paid-fallback permission.
    const freeEligible = isPoolFreeEligible(adapter.profile);
    const paidAllowed = ctx.apiFailoverPolicy?.mode === "freeFirst" && ctx.apiFailoverPolicy.allowPaidFallback === true;
    if (!freeEligible && !paidAllowed) continue;
    const usable = await ctx.launcher.providerUsability(id);
    if (usable.usable) return { providerId: id, index: i };
  }
  return undefined;
}

/** Retained stderr tail (bytes) for auto-routed CLI failure classification. */
const AUTO_ROUTE_STDERR_TAIL_BYTES = 8192;

/**
 * Carry a prepared launch: API providers run the generic CONTINUUM API agent;
 * CLI providers spawn their native binary (with native-session capture).
 *
 * Automatic-routing fallback: when the launch was selected by the provider-
 * preference chain (`prep.autoRoute`) is used by the API harness, one
 * composite runner owns the full candidate pool underneath one runAgentLoop.
 * Only quota/rate-limit/outage/network failures (plus configured auth
 * disablement) switch candidates; malformed/config errors fail immediately.
 * On the CLI harness the child's exit code plus a bounded sanitized stderr
 * tail are classified generically (see launcher/cli-failure.ts): provider-
 * side failures (rate-limit/upstream/network/auth) fall back; user interrupts,
 * ordinary task failures, permission denials and anything unattributable do
 * not. Explicit provider/model selections never fall back — they keep the
 * original fail-fast behavior. Every path is bounded by the finite chain.
 */
export async function launchPrepared(ctx: { launcher: Launcher; providers: ProviderRegistry; sessionManager: SessionManager; pricing?: PricingAwarenessService; dataDir: string; apiFailoverPolicy?: FailoverPolicy; interactive?: boolean }, prep: LaunchPreparation, out: (s: string) => void, spawnFn: (plan: import("../../launcher/types.js").LaunchPlan) => Promise<{ exitCode: number | null; stderrTail?: string }> = spawnCli): Promise<number> {
  if (prep.runtimeKind === "api") {
    const adapter = ctx.providers.get(prep.providerRef.providerId);
    // Run-scoped raw-output store: a `tool-output://` handle produced this run
    // stays retrievable for the whole run (the shared disk store prunes
    // globally by mtime and could evict a mid-run handle).
    const rawStore = new MemoryRawOutputStore();
    const tools = await buildToolRegistry({
      dataDir: ctx.dataDir,
      coding: { projectPath: prep.project.path },
      rawStore,
      // Direct-API `memory_recall` / `memory_search` / `memory_capture` must hit
      // the SAME per-project MemoryCore bucket the launcher's context injection
      // uses — never the global `default` bucket. Project-mode only; general /
      // current-directory sessions keep the base identity by design.
      ...(prep.projectScope ? { memoryProjectScope: prep.projectScope } : {}),
    });
    const cache = new ToolResultCache({}, join(ctx.dataDir, "tool-cache"));
    const scopeProvider = makeScopeProvider({ projectPath: prep.project.path, sessionManager: ctx.sessionManager });
    const sessionId = prep.session?.sessionId;
    const recordToolActivity = sessionId
      ? (tool: string, summary: string) => ctx.sessionManager.recordToolActivity(sessionId, tool, summary).then(() => undefined)
      : undefined;
    const candidates = await ctx.launcher.prepareApiFailoverCandidates(prep);
    const runner = prep.autoRoute
      ? createFailoverApiRunner(candidates, {
          ...ctx.apiFailoverPolicy,
          onSwitch: async (event) => {
            out(`${event.fromDisplayName} ${failoverReason(event.reason)} → ${event.toDisplayName}\n`);
            await ctx.apiFailoverPolicy?.onSwitch?.(event);
            if (sessionId) {
              const session = await ctx.sessionManager.loadSession(sessionId).catch(() => undefined);
              if (session) {
                const toAdapter = ctx.providers.get(event.toProviderId);
                const to = { providerId: event.toProviderId, model: toAdapter.resolveModel() };
                await ctx.sessionManager.recordHandoff(sessionId, {
                  handoffId: randomUUID(),
                  fromProvider: session.activeProvider,
                  toProvider: to,
                  at: new Date().toISOString(),
                }).catch(() => {});
                await ctx.sessionManager.setActiveProvider(sessionId, to).catch(() => {});
              }
            }
          },
        })
      : undefined;
    if (runner) {
      const pool = runner.status().map((candidate) => `${candidate.displayName}:${candidate.health}`).join(", ");
      out(`[route] Active ${adapter.profile.displayName}; API pool ${pool}\n`);
    }

    // Persistent interactive session — the Direct-API equivalent of a native
    // coding CLI's REPL. Only for an explicit single provider (never the
    // automatic free-API failover chain), and only when the caller asked for
    // it (a real TTY, no --print). One-shot behavior is otherwise unchanged.
    if (ctx.interactive && !runner) {
      return runInteractiveDirectApi({ adapter, tools, rawStore, cache, scopeProvider, recordToolActivity, prep, dataDir: ctx.dataDir, sessionManager: ctx.sessionManager });
    }

    try {
      const result = await runApiAgent({ adapter, ...(runner ? { runner } : {}), tools, rawStore, rendered: prep.rendered, query: prep.session?.taskGoal ?? "", onOutput: out, contextLimit: adapter.getCapabilities().contextWindowTokens, cache, scopeProvider, recordToolActivity, env: prep.plan.env });
      if (result.finalContent) out(`\n${result.finalContent}\n`);
      if (result.stopReason && result.stopReason !== "final") {
        out(`\nℹ️  Agent stopped early (${result.stopReason}) after ${result.iterations} iteration(s). The response above is partial.\n`);
      } else if (result.telemetry && (result.telemetry.outputTokens !== undefined || result.telemetry.requestMs !== undefined)) {
        out(`\nℹ️  ${telemetryOneLine(result.telemetry)}\n`);
      }
      return 0;
    } catch (err) {
      if (!(err instanceof ApiAgentError)) {
        out(`API agent error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      if (err instanceof ApiFailoverExhaustedError) out(`✗ ${err.message}\n`);
      else out(formatApiAgentFailure(adapter.profile.displayName, err));
      return 1;
    }
  }
  const startedAt = Date.now();
  if (!isStdinTty()) {
    out("⚠️  No interactive terminal detected — the native agent's UI may not start here.\n    Run `continuum` from a terminal window, or use a non-interactive provider.\n");
  }
  let lastPeak = ctx.pricing?.status(prep.providerRef.providerId)?.tier === "peak";
  let nativeUsageFile: string | undefined;
  let turnsBefore = 0;
  const writeTitle = async (): Promise<void> => {
    if (!(process.stderr as NodeJS.WriteStream).isTTY) return;
    try {
      const data = await buildHudData(prep, { launcher: ctx.launcher, providers: ctx.providers, pricing: ctx.pricing });
      const usage = nativeUsageFile ? await readClaudeUsage(nativeUsageFile) : undefined;
      process.stderr.write(`\u001b]0;${formatTerminalTitle(usage ? { ...data, contextUsed: usage.contextTokens } : data)}\u0007`);
    } catch { /* terminal decoration must never block the provider */ }
  };
  // Claude owns the PTY and redraws stdout, so the terminal title is the
  // durable status surface for the entire child lifetime.
  await writeTitle();
  if (prep.session && prep.providerRef.providerId === "deepseek") {
    const launch = ctx.providers.get("deepseek").resolveCliLaunch(prep.route);
    const id = prep.session.nativeSessionIds?.deepseek ?? prep.session.sessionId;
    if (launch.nativeResume?.supported && id) {
      nativeUsageFile = await nativeSessionFile(launch.nativeResume.sessionStore, id);
      if (nativeUsageFile) turnsBefore = (await readClaudeTurns(nativeUsageFile)).length;
    }
  }
  let rolloverWarned = false;
  // Codex cannot be assigned a native session id up front. Capture it while
  // the child is alive so a closed terminal or killed parent does not leave
  // the logical session without a native conversation to resume.
  let nativeSessionCaptured = !needsNativeSessionCapture(ctx.launcher, prep);
  let nativeCaptureInFlight: Promise<void> | undefined;
  const captureNativeSession = async (): Promise<void> => {
    if (nativeSessionCaptured) return;
    if (nativeCaptureInFlight) return nativeCaptureInFlight;
    nativeCaptureInFlight = (async () => {
      nativeSessionCaptured = await recordNativeSessionAfterLaunch(ctx.launcher, prep, startedAt);
    })().finally(() => { nativeCaptureInFlight = undefined; });
    return nativeCaptureInFlight;
  };
  const monitor = setInterval(async () => {
    try {
      await captureNativeSession();
      const peak = ctx.pricing?.status(prep.providerRef.providerId);
      if (peak?.tier === "peak") {
        const end = peak.endsAt ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(peak.endsAt) : "unknown";
        if (!lastPeak) out(`\n💲 DeepSeek entered peak pricing (${peak.multiplier}×); peak ends ${end} local.\n`);
        lastPeak = true;
      } else if (lastPeak) { lastPeak = false; }
      await writeTitle();
      if (!nativeUsageFile && prep.session && prep.providerRef.providerId === "deepseek") {
        const launch = ctx.providers.get("deepseek").resolveCliLaunch(prep.route);
        if (launch.nativeResume?.supported) {
          nativeUsageFile = await nativeSessionFile(launch.nativeResume.sessionStore, prep.session.nativeSessionIds?.deepseek ?? prep.session.sessionId);
          if (nativeUsageFile) turnsBefore = (await readClaudeTurns(nativeUsageFile)).length;
        }
      }
      if (!rolloverWarned && prep.session) {
        const launch = ctx.providers.get(prep.providerRef.providerId).resolveCliLaunch(prep.route);
        const nr = launch.nativeResume;
        const nativeId = prep.session.nativeSessionIds?.[prep.providerRef.providerId] ?? prep.session.sessionId;
        if (nr?.supported && nativeId) {
          const file = await nativeSessionFile(nr.sessionStore, nativeId);
          if (file) {
            const usage = await readClaudeUsage(file);
            const decision = evaluateRollover(usage, prep.providerRef.model, { ...DEFAULT_ROLLOVER_POLICY, mode: "tokens" });
            if (decision.rollover) {
              rolloverWarned = true;
              out(`\n💲 Native context reached ${usage.contextTokens.toLocaleString()} estimated tokens. Exit normally and run continuum resume ${prep.session.sessionId}; CONTINUUM will evaluate a safe handoff rollover. The active process was not killed.\n`);
            }
          }
        }
      }
    } catch { /* advisory monitor */ }
  }, 5_000);
  monitor.unref();
  // Auto-routed CLI launches opt into bounded stderr capture so a runtime
  // provider failure can be classified and routed to the next chain member;
  // explicit-provider launches spawn with plain inherited stdio.
  const cliPlan =
    prep.autoRoute && prep.session
      ? { ...prep.plan, stderrTailBytes: AUTO_ROUTE_STDERR_TAIL_BYTES }
      : prep.plan;
  const spawned = spawnFn(cliPlan);
  // Native stores are often created during spawn. Catch that fast path now;
  // the monitor retries when provider initialization takes longer.
  await captureNativeSession();
  const result = await spawned;
  clearInterval(monitor);
  if (lastPeak) process.stderr.write("\u001b]0;CONTINUUM\u0007");
  await captureNativeSession();
  if (prep.session && prep.providerRef.providerId === "deepseek") {
    try {
      const launch = ctx.providers.get(prep.providerRef.providerId).resolveCliLaunch(prep.route);
      const nr = launch.nativeResume;
      const nativeId = (await ctx.sessionManager.loadSession(prep.session.sessionId)).nativeSessionIds?.deepseek;
      if (nr?.supported && nativeId) {
        const file = await nativeSessionFile(nr.sessionStore, nativeId);
        if (file) {
          const turns = await readClaudeTurns(file);
          const store = new CostTelemetryStore(ctx.dataDir);
          for (const turn of turns.slice(nativeUsageFile === file ? turnsBefore : 0)) {
            const at = turn.at ?? new Date().toISOString();
            const peak = ctx.pricing?.status("deepseek", new Date(at));
            const multiplier = peak?.multiplier ?? 1;
            await store.append({ schemaVersion: 1, at, logicalSessionId: prep.session.sessionId, nativeSessionId: nativeId, providerId: "deepseek", model: prep.providerRef.model, kind: "turn", estimate: true, peak: peak?.tier === "peak", multiplier, usage: turn.usage, estimatedUsd: estimateCostUsd(turn.usage, prep.providerRef.model, multiplier) });
          }
        }
      }
    } catch { /* telemetry must not break launch */ }
  }
  // Automatic-routing runtime fallback (CLI harness): classify the failed
  // child's exit code plus bounded sanitized stderr tail and, only for a
  // provider-side failure (rate-limit/upstream/network/auth), continue on the
  // next usable chain member — the same semantics the API-agent branch above
  // applies to any ApiAgentError. User interrupts, ordinary task failures,
  // permission denials and unattributable exits surface normally.
  if (
    prep.autoRoute && prep.session &&
    result.exitCode !== null && result.exitCode !== 0
  ) {
    const classification = classifyCliFailure(result.exitCode, result.stderrTail);
    const fallback = classification.fallbackEligible
      ? await nextAutomaticFallback(ctx, prep)
      : undefined;
    if (!fallback) return result.exitCode;
    const failedAdapter = ctx.providers.get(prep.providerRef.providerId);
    const fallbackAdapter = ctx.providers.get(fallback.providerId);
    out(`ℹ️  ${failedAdapter.profile.displayName} unavailable (${classification.kind}) — falling back to ${fallbackAdapter.profile.displayName} (automatic routing).\n`);
    let next: LaunchPreparation;
    try {
      next = await ctx.launcher.prepareLaunch(
        { sessionId: prep.session.sessionId, providerId: fallback.providerId },
        { autoFallbackFrom: prep.providerRef.providerId },
      );
    } catch (prepareErr) {
      out(`✗ Automatic fallback to ${fallbackAdapter.profile.displayName} failed: ${prepareErr instanceof Error ? prepareErr.message : String(prepareErr)}\n`);
      return result.exitCode;
    }
    out(`Model decision: ${next.providerRef.model} — ${next.modelDecision.reason}\n`);
    if (ctx.pricing) await recordLaunchDecisions(next, ctx.dataDir, ctx.pricing).catch(() => {});
    // Preserve the remaining route on the re-prepared launch. If this member
    // uses the API harness, its one runAgentLoop receives the rest of the pool;
    // if it is another CLI member, runtime fallback can continue to member N.
    return launchPrepared(ctx, { ...next, autoRoute: { chain: prep.autoRoute.chain, index: fallback.index } }, out, spawnFn);
  }
  return result.exitCode ?? 0;
}

/**
 * Persistent interactive Direct-API session (managed local models / API-only
 * providers). Keeps one conversation + session + project + provider + memory
 * scope + tool state across turns until `/exit` or Ctrl-D. The managed local
 * service is deliberately NOT stopped on exit.
 */
async function runInteractiveDirectApi(a: {
  adapter: import("../../providers/types.js").ProviderAdapter;
  tools: import("../../mcp/tools.js").ToolRegistry;
  rawStore: MemoryRawOutputStore;
  cache: ToolResultCache;
  scopeProvider: import("../../tool-cache/tool-cache.js").ToolScopeProvider;
  recordToolActivity?: (tool: string, summary: string) => Promise<void>;
  prep: LaunchPreparation;
  dataDir: string;
  sessionManager: SessionManager;
}): Promise<number> {
  const { adapter, prep } = a;
  const io = createReplIo();
  const descriptor = adapter.profile.localService ? resolveLocalServiceDescriptor(adapter.profile) : undefined;
  const serviceManager = descriptor ? new LocalServiceManager({ dataDir: a.dataDir }) : undefined;
  try {
    const outcome = await runInteractiveApiSession({
      adapter,
      tools: a.tools,
      rendered: prep.rendered,
      initialQuery: prep.session?.taskGoal ?? "",
      contextLimit: adapter.getCapabilities().contextWindowTokens,
      env: prep.plan.env,
      cache: a.cache,
      scopeProvider: a.scopeProvider,
      rawStore: a.rawStore,
      ...(a.recordToolActivity ? { recordToolActivity: a.recordToolActivity } : {}),
      onExchange: async (userText, assistantText) => {
        await a.tools.call("memory_capture", { user_content: userText, assistant_content: assistantText }).catch(() => {});
      },
      io,
      info: {
        sessionId: prep.session?.sessionId ?? "(none)",
        projectLabel: prep.project.name,
        projectPath: prep.project.path,
        providerId: prep.providerRef.providerId,
        model: prep.providerRef.model,
        ...(prep.projectScope ? { memoryScope: `project-${prep.projectScope}` } : {}),
        service: async () => {
          if (!descriptor || !serviceManager) return { state: "n/a" };
          const s = await serviceManager.status(descriptor).catch(() => undefined);
          if (!s) return { state: "unknown" };
          return {
            state: s.state,
            ...(s.pid !== undefined ? { pid: s.pid } : {}),
            endpoint: `http://${s.host}:${s.port}${descriptor.healthPath}`,
          };
        },
      },
    });
    return outcome.endedBy === "exit" || outcome.endedBy === "eof" ? 0 : 0;
  } finally {
    io.close();
  }
}

/**
 * When the user granted one-time MCP auto-configure permission, ensure the
 * CONTINUUM MCP server is registered with the installed native CLIs before a
 * launch. Idempotent; never overwrites unrelated user MCP servers.
 */
export async function ensureMcpRegistration(): Promise<void> {
  const config = await new ConfigStore(resolveDataDir()).load();
  await ensureMcpRegistered(liveRuntime, [claudeProfile.cliLaunch, codexProfile.cliLaunch], config.mcpAutoConfigure);
}

/**
 * Whether a launch should open the persistent interactive Direct-API session.
 *
 * Opt-outs that ALWAYS win (automation / scripting must stay one-shot):
 *   - `--print` / `--one-shot` / `-1` on the command line
 *   - `CONTINUUM_ONE_SHOT=1` in the environment
 *   - `io.nonInteractive` (print-mode host)
 *
 * Otherwise interactive when the session is genuinely a human one:
 *   - `trustedInteractive` — the caller is the interactive front-door menu
 *     (`continuum` with no subcommand, incl. the CONTINUUM.app desktop
 *     launcher), which has already refused to run without a TTY. This is the
 *     explicit trusted signal so we never depend on TTY bits surviving the
 *     Terminal.app → osascript → shell → `exec` chain.
 *   - else: both stdin and stdout are real TTYs (a user typing `continuum
 *     launch …` directly).
 *
 * Native-CLI providers are unaffected — this only gates the API-agent branch.
 */
export function wantsInteractive(args: readonly string[], io: CliIo, opts: { trustedInteractive?: boolean } = {}): boolean {
  if (args.includes("--print") || args.includes("--one-shot") || args.includes("-1")) return false;
  if (process.env.CONTINUUM_ONE_SHOT === "1") return false;
  if (io.nonInteractive) return false;
  if (opts.trustedInteractive) return true;
  return isStdinTty() && Boolean((process.stdout as NodeJS.WriteStream).isTTY);
}

export async function runLaunchCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const prompt = createPrompt();
  const { launcher, pricing, handoffManager, providers, sessionManager, dataDir, memoryCoreConfigured } = await buildLauncherContext({
    prompt,
    onDependencyProgress: (line) => out(`ℹ️  ${line}\n`),
  });

  const projectKey = args.find((a) => !a.startsWith("-"));
  const providerId = opt(args, "--provider", "-p");
  const modelAlias = opt(args, "--model");
  const taskGoal = opt(args, "--task", "-t");
  // Explicit permission choice only: `--bypass-permissions` forces full access,
  // `--safe` forces normal approval mode. Absent → the launcher's global
  // bypass default applies for every CLI provider that declares a native flag.
  const bypass = args.includes("--bypass-permissions") || args.includes("--dangerously-bypass");
  const safe = args.includes("--safe");
  const permissionMode: "safe" | "bypass" | undefined = bypass ? "bypass" : safe ? "safe" : undefined;
  // No-project launches (see src/launcher/launcher.ts's SessionMode): "general"
  // has no fixed directory anchor; "current-directory" anchors to the launch
  // cwd without registering it as a project. Mutually exclusive with a
  // positional project key.
  const general = args.includes("--general");
  const currentDir = args.includes("--current-dir") || args.includes("--here");
  const mode: "general" | "current-directory" | undefined = general ? "general" : currentDir ? "current-directory" : undefined;
  const apiFailoverPolicy = apiFailoverPolicyFromArgs(args);

  try {
    // Preflight + self-heal: recover the Tencent stack (via the existing
    // doctor --repair cascade) BEFORE the session starts, so a healthy launch
    // gets full memory and only a genuine, unrecoverable failure degrades.
    for (const warning of await runLaunchPreflight(memoryCoreConfigured, (line) => out(`ℹ️  ${line}\n`))) out(`⚠️  ${warning}\n`);

    const prep = await launcher.prepareLaunch(
      { ...(mode ? {} : projectKey ? { projectKey } : {}), ...(mode ? { mode } : {}), providerId, modelAlias, taskGoal },
      { permissionMode, allowPaidFallback: apiFailoverPolicy.allowPaidFallback },
    );

    if (prep.stale) {
      out(`⚠️  Stale state detected:\n${prep.staleReasons.map((r) => `  - ${r}`).join("\n")}\n`);
    }
    if (prep.memoryCoreNote) out(`ℹ️  ${prep.memoryCoreNote}\n`);
    if (prep.session) out(`Session: ${prep.session.sessionId}\n`);
    if (prep.nativeResume) out(`ℹ️  Resuming ${prep.nativeResume.providerId} native session ${prep.nativeResume.nativeSessionId}\n`);
    if (prep.rollover) out(`💲 Context rollover: preserved ${prep.rollover.fromNativeSessionId}; fresh native session ${prep.rollover.toNativeSessionId}\n   Handoff: ${prep.rollover.handoffFile}\n   ${prep.rollover.reason}\n`);
    if (prep.modelDecision) out(`Model decision: ${prep.providerRef.model} — ${prep.modelDecision.reason}\n`);
    printPermissionState(out, prep);
    await recordLaunchDecisions(prep, dataDir, pricing);
    printProviderIdentity(out, prep, providers);
    await printHud(out, prep, { launcher, providers, pricing }, getTerminalColumns());

    // Peak-pricing handoff prompt: before launching, check the session's
    // active provider for a pricing transition; if a peak event fires, surface
    // a handoff suggestion (never auto-trigger). Only offers authenticated agents.
    if (prep.session) {
      const pricingLines = await checkPricing(prep.session.sessionId, pricing, handoffManager);
      for (const line of pricingLines) out(line);
      printPeakProWarning(out, prep, pricing);
    }

    await ensureMcpRegistration();
    // Hand a clean, un-paused TTY to the spawned agent.
    prompt.close();
    return launchPrepared({ launcher, providers, sessionManager, pricing, dataDir, apiFailoverPolicy, interactive: wantsInteractive(args, io) }, prep, out);
  } catch (err) {
    if (err instanceof NoProjectError || err instanceof ProviderNotAuthenticatedError || err instanceof NoAuthenticatedAgentError || err instanceof LocalDependencyUnavailableError || err instanceof LocalServiceUnavailableError || err instanceof ModelUnavailableError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    prompt.close();
  }
}

export async function runResumeCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const sessionId = args.find((a) => !a.startsWith("-"));
  const providerId = opt(args, "--provider", "-p");
  const modelAlias = opt(args, "--model");
  // `--recent N` resumes the Nth most-recent session (no id to memorize).
  const recentN = Number(opt(args, "--recent") ?? "nan");
  const bypass = args.includes("--bypass-permissions") || args.includes("--dangerously-bypass");
  const safe = args.includes("--safe");
  const permissionMode: "safe" | "bypass" | undefined = bypass ? "bypass" : safe ? "safe" : undefined;

  const prompt = createPrompt();
  const { launcher, sessionManager, providers, pricing, handoffManager, dataDir, memoryCoreConfigured } = await buildLauncherContext({
    prompt,
    onDependencyProgress: (line) => out(`ℹ️  ${line}\n`),
  });

  let targetSessionId = sessionId;
  if (!targetSessionId && Number.isFinite(recentN)) {
    const sessions = await listRecentSessions(sessionManager, recentN);
    targetSessionId = sessions[recentN - 1]?.sessionId;
  }
  if (!targetSessionId) {
    out("Usage: continuum resume <sessionId> [--provider X] | --recent N\n");
    return 2;
  }

  try {
    // Self-heal the Tencent stack before resuming, same as a fresh launch.
    for (const warning of await runLaunchPreflight(memoryCoreConfigured, (line) => out(`ℹ️  ${line}\n`))) out(`⚠️  ${warning}\n`);

    const prep = await launcher.prepareLaunch(
      { sessionId: targetSessionId, ...(providerId ? { providerId } : {}), ...(modelAlias ? { modelAlias } : {}) },
      { permissionMode },
    );
    if (prep.stale) {
      out(`⚠️  Stale state detected:\n${prep.staleReasons.map((r) => `  - ${r}`).join("\n")}\n`);
    }
    if (prep.session) out(`Resuming session: ${prep.session.sessionId} [${prep.plan.providerId}]\n`);
    if (prep.nativeResume) out(`ℹ️  Resuming ${prep.nativeResume.providerId} native session ${prep.nativeResume.nativeSessionId}\n`);
    if (prep.rollover) out(`💲 Context rollover: preserved ${prep.rollover.fromNativeSessionId}; fresh native session ${prep.rollover.toNativeSessionId}\n   Handoff: ${prep.rollover.handoffFile}\n   ${prep.rollover.reason}\n`);
    if (prep.modelDecision) out(`Model decision: ${prep.providerRef.model} — ${prep.modelDecision.reason}\n`);
    printPermissionState(out, prep);
    await recordLaunchDecisions(prep, dataDir, pricing);
    printProviderIdentity(out, prep, providers);
    await printHud(out, prep, { launcher, providers, pricing }, getTerminalColumns());
    if (prep.session) for (const line of await checkPricing(prep.session.sessionId, pricing, handoffManager)) out(line);
    printPeakProWarning(out, prep, pricing);
    await ensureMcpRegistration();
    prompt.close();
    return launchPrepared({ launcher, providers, sessionManager, pricing, dataDir, apiFailoverPolicy: apiFailoverPolicyFromArgs(args), interactive: wantsInteractive(args, io) }, prep, out);
  } catch (err) {
    if (err instanceof NoAuthenticatedAgentError || err instanceof ProviderNotAuthenticatedError || err instanceof LocalDependencyUnavailableError || err instanceof LocalServiceUnavailableError || err instanceof ModelUnavailableError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    prompt.close();
  }
}

export async function runHandoffCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const sessionId = args.find((a) => !a.startsWith("-"));
  if (!sessionId) {
    out("Usage: continuum handoff <sessionId>\n");
    return 2;
  }
  const prompt = createPrompt();
  const { launcher, handoffManager, sessionManager, providers, dataDir } = await buildLauncherContext({
    prompt,
    onDependencyProgress: (line) => out(`ℹ️  ${line}\n`),
  });

  try {
    // Which *available authenticated* agents can take over — never auto-select.
    const authenticated = await launcher.listAuthenticatedProviders();
    const { session } = await handoffManager.prepareHandoff(sessionId);
    const candidates = authenticated.filter((a) => a.providerId !== session.activeProvider.providerId);
    if (candidates.length === 0) {
      out("No other authenticated agent is available to take over.\n");
      return 2;
    }

    out(`Available agents to take over: ${candidates.map((c) => c.providerId).join(", ")}\n`);
    const chosen = await prompt.ask(`Hand off to which agent? [${candidates.map((c) => c.providerId).join("/")}]`);
    const chosenId = candidates.find((c) => c.providerId === chosen)?.providerId ?? candidates[0]!.providerId;

    const targetAdapter = providers.get(chosenId);
    const result = await handoffManager.finalizeHandoff(sessionId, chosenId, {
      tokenLimits: { contextWindow: targetAdapter.getCapabilities().contextWindowTokens ?? 200_000, reservedOutput: 8192 },
    });
    out(`Handed off to ${chosenId} (session ${result.session.sessionId}, active provider set).\n`);

    // Launch the receiving agent in the same project, continuing the session.
    // Handoff-receiving launches inherit the global bypass default (every CLI
    // provider with a declared native flag) — explicit `--safe` opts back out.
    const bypass = args.includes("--bypass-permissions") || args.includes("--dangerously-bypass");
    const safe = args.includes("--safe");
    const permissionMode: "safe" | "bypass" | undefined = bypass ? "bypass" : safe ? "safe" : undefined;
    const prep = await launcher.prepareLaunch({ sessionId, providerId: chosenId }, { permissionMode });
    printPermissionState(out, prep);
    printProviderIdentity(out, prep, providers);
    await printHud(out, prep, { launcher, providers }, getTerminalColumns());
    await ensureMcpRegistration();
    prompt.close();
    return launchPrepared({ launcher, providers, sessionManager, dataDir }, prep, out);
  } catch (err) {
    if (err instanceof NoAuthenticatedAgentError || err instanceof LocalDependencyUnavailableError || err instanceof LocalServiceUnavailableError) {
      out(`${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    prompt.close();
  }
}
