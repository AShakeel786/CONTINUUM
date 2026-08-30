/**
 * `continuum doctor [--repair]` — health report + explicit, bounded recovery.
 *
 * Without `--repair`: read-only report over auth + runtime stack (docker
 * containers, gateways, provider CLI, credentials, sessions, stale procs).
 * With `--repair`: runs recovery ONLY for failed checks, gated by cooldown +
 * circuit-breaker state, then re-checks and prints the final verdict.
 *
 * Nothing here prints secret values; every detail string is safe to show.
 */

import { join } from "node:path";
import { Doctor } from "../../auth/doctor.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { HealthDoctor } from "../../health/doctor.js";
import {
  DEFAULT_OPTIONS,
  DEFAULT_POLICY,
  auditSessionStore,
  liveRuntime,
  scanStaleProviderProcesses,
} from "../../health/adapters.js";
import { isMcpRegistered, mcpServerCommand, registerMcpIfMissing } from "../../mcp/registration.js";
import { verifyMcpHealth } from "../../mcp/health.js";
import { verifyCliContract } from "../../launcher/cli-contract.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { resolveMemoryCoreConfig } from "../../context/memorycore-config.js";
import type { CliIo } from "../index.js";
import { buildContext } from "./common.js";

const NATIVE_CLI_PROFILES = [claudeProfile, codexProfile] as const;

export async function runDoctorCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const repair = args.includes("--repair");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const ctx = await buildContext({ prompt: createPrompt() });
  const config = await ctx.configStore.load();

  // ── Auth doctor (existing) ─────────────────────────────────────────────
  const authDoctor = new Doctor({
    credentialManager: ctx.credentialManager,
    cliAuthManager: ctx.cliAuthManager,
    providerMetadata: ctx.providerMetadata,
    // A config entry persisted under a legacy provider id (ox-alpha) still
    // reports against its current canonical identity (glm-5-2-free).
    resolveProviderId: (id) => ctx.providers.canonicalId(id) ?? id,
  });
  const authReport = await authDoctor.diagnose(config);

  // Resolve the canonical memory configuration before runtime diagnosis. The
  // local endpoint defaults to 127.0.0.1 and the token may live in Keychain,
  // so checking only CONTINUUM_MEMORY_CORE_URL misclassifies configured Macs.
  const memoryResolution = await resolveMemoryCoreConfig({ credentialManager: ctx.credentialManager });

  // ── Runtime health doctor (Phase 14) ───────────────────────────────────
  const providerExecutables = DEFAULT_OPTIONS.providerExecutables;
  const healthDoctor = new HealthDoctor({
    runtime: liveRuntime,
    options: {
      ...DEFAULT_OPTIONS,
      stateFile: join(ctx.dataDir, "health-state.json"),
      memoryCoreUrl: DEFAULT_OPTIONS.memoryCoreUrl,
      tencentConfigured: memoryResolution.config !== undefined,
    },
    policy: { ...DEFAULT_POLICY },
    probes: {
      providerStatus: async () => authReport.findings.map((f) => ({ providerId: f.providerId, method: f.method, healthy: f.healthy, detail: f.detail })),
      credentialStatus: async () => ({
        backendId: ctx.backend.id,
        securityLevel: ctx.backend.securityLevel,
        available: true,
        detail: ctx.backend.description,
      }),
      sessionStatus: async () => auditSessionStore(join(ctx.dataDir, "sessions")),
      staleProcesses: async () => scanStaleProviderProcesses([...providerExecutables]),
    },
  });

  const before = await healthDoctor.diagnose();

  // Gather the memory + native-CLI surface up front, so a healthy `--repair`
  // can collapse to a short no-op instead of printing the full report twice.
  const mcpHealth = await verifyMcpHealth(mcpServerCommand());

  const nativeCli: { profileId: string; contractOk: boolean; contractDetail: string; mcpRegistered: boolean }[] = [];
  for (const profile of NATIVE_CLI_PROFILES) {
    const adapter = createProviderAdapter(profile);
    const contract = await verifyCliContract(liveRuntime, adapter);
    const registered = await isMcpRegistered(liveRuntime, profile.cliLaunch);
    nativeCli.push({ profileId: profile.id, contractOk: contract.ok, contractDetail: contract.detail, mcpRegistered: registered });
  }

  const authHealthy = authReport.overall === "healthy";
  const runtimeHealthy = before.overall === "healthy";
  const memoryConfigured = memoryResolution.config !== undefined;
  const mcpRepairPending = config.mcpAutoConfigure === true && nativeCli.some((n) => !n.mcpRegistered);
  // Nothing `--repair` would actually change: auth + runtime healthy and no
  // pending MCP registration. Memory config is a setup step, not a repair, so
  // it doesn't block the collapse — it becomes a one-line hint instead.
  const nothingToRepair = authHealthy && runtimeHealthy && !mcpRepairPending;

  // Healthy `doctor --repair`: collapse to a short, honest no-op message.
  if (repair && !verbose && nothingToRepair) {
    out("Doctor: all checks healthy — nothing to repair.");
    if (!memoryConfigured) out(" (MemoryCore not configured — run `continuum setup --memory`.)");
    out("\n");
    return 0;
  }

  // ── Full report ────────────────────────────────────────────────────────
  out(`Backend: ${authReport.backendId} (${authReport.backendSecurityLevel})\n`);
  out(`Overall: ${authReport.overall}\n`);
  if (authReport.findings.length === 0) {
    out("No providers configured.\n");
  }
  for (const f of authReport.findings) {
    out(`${f.healthy ? "  ok" : "  !! "} ${f.providerId} [${f.method}]: ${f.detail}\n`);
  }

  // DeepSeek routing is reported independently: direct (standalone, no Tencent)
  // vs the optional Tencent MemoryProxy path. A missing Tencent stack must
  // never make standalone DeepSeek unhealthy.
  out(`\nProvider routing:\n`);
  const deepseekRoute = config.proxyRouting?.["deepseek"] ?? "direct";
  out(`  deepseek: ${deepseekRoute === "proxy" ? "Tencent MemoryProxy (optional)" : "direct (standalone — no Tencent/Docker)"}\n`);
  out("  API failover: free-only by default; trial/paid and non-pool-eligible providers require --allow-paid-fallback\n");

  out(`\nRuntime stack:\n`);
  for (const line of HealthDoctor.formatReport(before)) out(`${line}\n`);

  out(`\nMemory config (launch/MCP):\n`);
  if (memoryResolution.config) {
    const src = memoryResolution.config.serviceToken.envVar !== undefined ? `env ${memoryResolution.config.serviceToken.envVar}` : "secure credential store";
    out(`  ok memory gateway: ${memoryResolution.config.baseUrl} (service token from ${src})\n`);
  } else {
    out(`  !! ${memoryResolution.reason}\n`);
  }

  out(`\nNative CLI (MCP + session contract):\n`);
  if (config.mcpAutoConfigure === undefined) {
    out("  MCP auto-configure: not yet decided (run `continuum setup`).\n");
  } else if (config.mcpAutoConfigure) {
    out("  MCP auto-configure: enabled\n");
  } else {
    out("  MCP auto-configure: disabled (run: continuum mcp-setup to register manually)\n");
  }
  const healthIcon = mcpHealth.status === "reachable" ? "ok" : "!!";
  out(`  ${healthIcon} continuum-mcp: ${mcpHealth.status} (${mcpHealth.detail})\n`);
  for (const n of nativeCli) {
    out(`  ${n.contractOk ? "ok" : "!! "} ${n.profileId} session contract: ${n.contractDetail}\n`);
    out(`  ${n.mcpRegistered ? "ok" : "-- "} ${n.profileId} MCP: ${n.mcpRegistered ? "registered" : "not registered"}\n`);
  }

  if (!repair) {
    return runtimeHealthy && authHealthy ? 0 : 1;
  }

  // MCP repair: only when auto-configure permission is enabled, and only
  // CONTINUUM's own registration (never removes/overwrites unrelated servers).
  out(`\nMCP repair:\n`);
  if (config.mcpAutoConfigure !== true) {
    out("  skipped — MCP auto-configure disabled (run: continuum mcp-setup to register manually)\n");
  } else {
    for (const profile of NATIVE_CLI_PROFILES) {
      const result = await registerMcpIfMissing(liveRuntime, profile.cliLaunch);
      out(`  [${result.status}] ${profile.id} MCP: ${result.detail}\n`);
    }
  }

  out(`\nRepair pass (explicit, bounded by cooldown + circuit breaker):\n`);
  const { outcomes, after } = await healthDoctor.repair();
  if (outcomes.length === 0) {
    out("  nothing to repair — all failed checks lack an automatic strategy (see directives above)\n");
  }
  for (const o of outcomes) out(`${HealthDoctor.formatOutcome(o)}\n`);

  out(`\nAfter repair:\n`);
  for (const line of HealthDoctor.formatReport(after)) out(`${line}\n`);

  return after.overall === "healthy" && authHealthy ? 0 : 1;
}
