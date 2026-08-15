/**
 * `continuum doctor` — read-only health report.
 */

import { Doctor } from "../../auth/doctor.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import type { CliIo } from "../index.js";
import { buildContext } from "./common.js";

export async function runDoctorCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const ctx = await buildContext({ prompt: createPrompt() });
  const config = await ctx.configStore.load();

  const doctor = new Doctor({
    credentialManager: ctx.credentialManager,
    cliAuthManager: ctx.cliAuthManager,
    providerMetadata: ctx.providerMetadata,
  });

  const report = await doctor.diagnose(config);

  out(`Backend: ${report.backendId} (${report.backendSecurityLevel})\n`);
  out(`Overall: ${report.overall}\n`);
  if (report.findings.length === 0) {
    out("No providers configured.\n");
    return report.overall === "healthy" ? 0 : 1;
  }
  for (const f of report.findings) {
    out(`${f.healthy ? "  ok" : "  !! "} ${f.providerId} [${f.method}]: ${f.detail}\n`);
  }
  return report.overall === "healthy" ? 0 : 1;
}
