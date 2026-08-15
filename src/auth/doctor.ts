/**
 * `continuum doctor` — a read-only health report over onboarding/auth state.
 *
 * Never writes, never prompts, never holds a secret value longer than a
 * single existence check. Reports, for each configured provider, whether its
 * recorded auth method still holds up against the live credential store and
 * (for CLI auth) the provider's own CLI status. "Unhealthy" here means the
 * config or store disagree (config references a credential key that no
 * longer resolves, or CLI auth that's no longer authenticated) — the exact
 * drift a user would want surfaced before relying on a long-forgotten setup.
 */

import type { CredentialManager } from "./credential-manager.js";
import type { CliAuthManager } from "./cli-auth-manager.js";
import type { ProviderAuthMetadata } from "./types.js";
import type { ContinuumConfig } from "../config/types.js";
import { AuthVerifier } from "./auth-verifier.js";

export type DoctorOverall = "healthy" | "unhealthy";

export interface DoctorFinding {
  readonly providerId: string;
  readonly method: string;
  readonly healthy: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly overall: DoctorOverall;
  readonly backendId: string;
  readonly backendSecurityLevel: string;
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorDeps {
  readonly credentialManager: CredentialManager;
  readonly cliAuthManager: CliAuthManager;
  readonly providerMetadata: ReadonlyMap<string, ProviderAuthMetadata>;
}

export class Doctor {
  constructor(private readonly deps: DoctorDeps) {}

  async diagnose(config: ContinuumConfig): Promise<DoctorReport> {
    const verifier = new AuthVerifier({
      credentialManager: this.deps.credentialManager,
      cliAuthManager: this.deps.cliAuthManager,
    });

    const findings: DoctorFinding[] = [];
    for (const entry of config.providers) {
      const metadata = this.deps.providerMetadata.get(entry.providerId);
      if (!metadata) {
        findings.push({
          providerId: entry.providerId,
          method: entry.method,
          healthy: false,
          detail: "no provider metadata registered for this id",
        });
        continue;
      }
      const result =
        entry.method === "api" ? await verifier.verifyApi(metadata) : await verifier.verifyCli(metadata);
      findings.push({
        providerId: entry.providerId,
        method: entry.method,
        healthy: result.outcome === "ok",
        detail: result.detail,
      });
    }

    const overall: DoctorOverall = findings.every((f) => f.healthy) ? "healthy" : "unhealthy";
    return {
      overall,
      backendId: this.deps.credentialManager.backendId,
      backendSecurityLevel: this.deps.credentialManager.securityLevel,
      findings,
    };
  }
}
