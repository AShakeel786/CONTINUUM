export class LaunchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LaunchError";
    this.code = code;
  }
}

export class MissingCliError extends LaunchError {
  constructor(providerId: string, executable: string) {
    super("missing-cli", `provider "${providerId}" requires the "${executable}" CLI, which is not installed or not on PATH.`);
    this.name = "MissingCliError";
  }
}

export class ProviderNotAuthenticatedError extends LaunchError {
  constructor(providerId: string, detail: string) {
    super("not-authenticated", `provider "${providerId}" is not authenticated: ${detail}. Run "continuum auth ${providerId}".`);
    this.name = "ProviderNotAuthenticatedError";
  }
}

export class NoAuthenticatedAgentError extends LaunchError {
  constructor(available: readonly string[]) {
    super(
      "no-authenticated-agent",
      available.length === 0
        ? "No authenticated agent is available to take over. Authenticate at least one provider first."
        : `No authenticated agent available among [${available.join(", ")}].`,
    );
    this.name = "NoAuthenticatedAgentError";
  }
}

export class StaleStateError extends LaunchError {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super("stale-state", `Session state is stale relative to the current worktree:\n- ${reasons.join("\n- ")}`);
    this.name = "StaleStateError";
    this.reasons = reasons;
  }
}

export class NoProjectError extends LaunchError {
  constructor() {
    super(
      "no-project",
      "No project found for the current directory, and none was named. Register with \"continuum project add\" first.",
    );
    this.name = "NoProjectError";
  }
}

/**
 * A proxy-routed provider's local dependency (the Tencent MemoryProxy) is
 * unreachable even after CONTINUUM's own bounded self-heal attempt — thrown
 * BEFORE any session is created or mutated (see Launcher.prepareLaunch), so
 * a retry after fixing the dependency always resumes cleanly. `detail` is
 * built entirely from HealthCheckResult/RepairOutcome text, which is
 * documented as always safe to print (no secrets).
 */
export class LocalDependencyUnavailableError extends LaunchError {
  readonly providerId: string;
  readonly endpoint: string;
  readonly sessionMode: string;
  constructor(providerId: string, endpoint: string, sessionMode: string, detail: string, repairAttempted: boolean) {
    const host = (() => {
      try {
        const u = new URL(endpoint);
        return u.port ? `${u.hostname}:${u.port}` : u.hostname;
      } catch {
        return endpoint;
      }
    })();
    super(
      "local-dependency-unavailable",
      `Provider "${providerId}" (${sessionMode} session) requires a local service at ${host} (local, not external) that is still unavailable` +
        `${repairAttempted ? " after an automatic recovery attempt" : ""}: ${detail}\n` +
        `Next step: run \`continuum doctor --repair\` for a detailed report, or start the Tencent memory stack manually, then retry the launch.`,
    );
    this.name = "LocalDependencyUnavailableError";
    this.providerId = providerId;
    this.endpoint = endpoint;
    this.sessionMode = sessionMode;
  }
}
