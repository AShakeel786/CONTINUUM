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
import { isMcpRegistered } from "../../mcp/registration.js";
import { verifyCliContract } from "../../launcher/cli-contract.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import type { CliIo } from "../index.js";
import { buildContext } from "./common.js";

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

  // Native CLI surface: MCP registration + session-contract drift (read-only).
  out(`\nNative CLI (MCP + session contract):\n`);
  for (const profile of [claudeProfile, codexProfile]) {
    const adapter = createProviderAdapter(profile);
    const contract = await verifyCliContract(liveRuntime, adapter);
    out(`  ${contract.ok ? "ok" : "!! "} ${profile.id} session contract: ${contract.detail}\n`);
    const registered = await isMcpRegistered(liveRuntime, profile.cliLaunch);
    out(`  ${registered ? "ok" : "-- "} ${profile.id} MCP: ${registered ? "continuum registered" : "continuum-mcp not registered (run: continuum mcp-setup)"}\n`);
  }

  if (!repair) {
    return before.overall === "healthy" && authReport.overall === "healthy" ? 0 : 1;
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
