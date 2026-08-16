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
import type { CliIo } from "../index.js";
import { buildContext } from "./common.js";

const NATIVE_CLI_PROFILES = [claudeProfile, codexProfile] as const;

export async function runDoctorCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const repair = args.includes("--repair");
  const ctx = await buildContext({ prompt: createPrompt() });
  const config = await ctx.configStore.load();

  // ── Auth doctor (existing) ─────────────────────────────────────────────
  const authDoctor = new Doctor({
    credentialManager: ctx.credentialManager,
    cliAuthManager: ctx.cliAuthManager,
    providerMetadata: ctx.providerMetadata,
  });
  const authReport = await authDoctor.diagnose(config);

  // ── Runtime health doctor (Phase 14) ───────────────────────────────────
  const providerExecutables = DEFAULT_OPTIONS.providerExecutables;
  const healthDoctor = new HealthDoctor({
    runtime: liveRuntime,
    options: {
      ...DEFAULT_OPTIONS,
      stateFile: join(ctx.dataDir, "health-state.json"),
      memoryCoreUrl: DEFAULT_OPTIONS.memoryCoreUrl,
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

  out(`Backend: ${authReport.backendId} (${authReport.backendSecurityLevel})\n`);
  out(`Overall: ${authReport.overall}\n`);
  if (authReport.findings.length === 0) {
    out("No providers configured.\n");
  }
  for (const f of authReport.findings) {
    out(`${f.healthy ? "  ok" : "  !! "} ${f.providerId} [${f.method}]: ${f.detail}\n`);
  }

  out(`\nRuntime stack:\n`);
  const before = await healthDoctor.diagnose();
  for (const line of HealthDoctor.formatReport(before)) out(`${line}\n`);

  // Native CLI surface: MCP permission + functional health + session contract.
  out(`\nNative CLI (MCP + session contract):\n`);
  if (config.mcpAutoConfigure === undefined) {
    out("  MCP auto-configure: not yet decided (run `continuum setup`).\n");
  } else if (config.mcpAutoConfigure) {
    out("  MCP auto-configure: enabled\n");
  } else {
    out("  MCP auto-configure: disabled (run: continuum mcp-setup to register manually)\n");
  }

  // Functional MCP health (the CONTINUUM server itself — same for every CLI).
  const mcpHealth = await verifyMcpHealth(mcpServerCommand());
  const healthIcon = mcpHealth.status === "reachable" ? "ok" : "!!";
  out(`  ${healthIcon} continuum-mcp: ${mcpHealth.status} (${mcpHealth.detail})\n`);

  for (const profile of NATIVE_CLI_PROFILES) {
    const adapter = createProviderAdapter(profile);
    const contract = await verifyCliContract(liveRuntime, adapter);
    out(`  ${contract.ok ? "ok" : "!! "} ${profile.id} session contract: ${contract.detail}\n`);
    const registered = await isMcpRegistered(liveRuntime, profile.cliLaunch);
    out(`  ${registered ? "ok" : "-- "} ${profile.id} MCP: ${registered ? "registered" : "not registered"}\n`);
  }

  if (!repair) {
    return before.overall === "healthy" && authReport.overall === "healthy" ? 0 : 1;
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

  return after.overall === "healthy" && authReport.overall === "healthy" ? 0 : 1;
}
