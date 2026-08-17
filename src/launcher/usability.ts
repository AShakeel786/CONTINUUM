/**
 * Provider usability — the single source of truth for "can CONTINUUM actually
 * launch/run this provider right now?", shared by the Launcher (agent picker /
 * handoff filtering / pre-launch gate) and the interactive agent-management
 * menu (list/status).
 *
 * Two distinct notions, deliberately kept separate:
 *   - `configured` (owned by the config layer) = the user completed auth setup
 *     and a config entry + credential reference exist.
 *   - `usable` (computed here) = CONTINUUM has a launch/run path for the
 *     provider *today*: a detected working CLI for CLI-launchable providers,
 *     or a compatible direct-API runtime for direct-API providers.
 *
 * API credentials alone never imply launchability.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { CliAuthManager } from "../auth/cli-auth-manager.js";
import type { CredentialManager } from "../auth/credential-manager.js";
import type { ProviderAuthMetadata } from "../auth/types.js";
import type { ProviderAdapter } from "../providers/types.js";

/** Per-provider usability, including a human-readable display name and (when unusable) a reason. */
export interface ProviderUsability {
  readonly providerId: string;
  readonly displayName: string;
  readonly model: string;
  readonly usable: boolean;
  readonly reason?: string;
}

/** How CONTINUUM would launch/run this provider. */
export type LaunchKind = "cli" | "direct-api" | "none";

export interface ProviderEvaluation {
  readonly usable: boolean;
  readonly reason?: string;
  readonly launchKind: LaunchKind;
  /** For CLI-launchable providers: whether the CLI executable was detected. */
  readonly cliInstalled?: boolean;
  /** For CLI-launchable providers with their own auth adapter: whether the CLI is authenticated. */
  readonly cliAuthenticated?: boolean;
}

export interface UsabilityDeps {
  readonly cliAuthManager: CliAuthManager;
  readonly credentialManager: CredentialManager;
  /** Overridable in tests; defaults to a PATH/absolute-path lookup. */
  readonly findExecutable?: (executable: string) => string | undefined;
}

/** Best-effort, side-effect-free "is this executable reachable on PATH (or an absolute path)?" */
export function findExecutableOnPath(executable: string): string | undefined {
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const candidates: string[] = [];
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    candidates.push(executable);
  } else {
    const pathVar = process.env.PATH ?? "";
    for (const dir of pathVar.split(delimiter)) {
      if (!dir) continue;
      for (const ext of extensions) candidates.push(join(dir, executable + ext));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * Evaluate one provider once, returning both launchability and (for CLI
 * providers) the CLI facts — so callers don't re-run subprocess checks.
 */
export async function evaluateProvider(
  adapter: ProviderAdapter,
  metadata: ProviderAuthMetadata,
  deps: UsabilityDeps,
): Promise<ProviderEvaluation> {
  const id = adapter.profile.id;

  // 1. Providers with their own CLI auth (Claude, Codex): the CLI must be
  //    installed *and* authenticated.
  if (metadata.cli.supported) {
    try {
      const installed = (await deps.cliAuthManager.checkInstalled(id)) === "installed";
      if (!installed) return { usable: false, reason: `${id} CLI not installed`, launchKind: "cli", cliInstalled: false };
      const authenticated = (await deps.cliAuthManager.checkAuthenticated(id)) === "authenticated";
      if (!authenticated) return { usable: false, reason: `${id} not authenticated`, launchKind: "cli", cliInstalled: true, cliAuthenticated: false };
      return { usable: true, launchKind: "cli", cliInstalled: true, cliAuthenticated: true };
    } catch {
      return { usable: false, reason: `${id} auth check failed`, launchKind: "cli" };
    }
  }

  // 2. CLI-launchable providers without their own CLI auth adapter (e.g.
  //    DeepSeek, proxy-routed through the `claude` CLI): the declared launch
  //    executable must be detected, plus the required API/proxy credentials.
  if (adapter.profile.capabilities.cliAvailable) {
    const executable = adapter.profile.cliLaunch.executable;
    const findExecutable = deps.findExecutable ?? findExecutableOnPath;
    const installed = findExecutable(executable) !== undefined;
    if (!installed) {
      return { usable: false, reason: `${id} CLI not installed (${executable} not found)`, launchKind: "cli", cliInstalled: false };
    }
    const cred = await checkCredentials(id, metadata, deps);
    if (!cred.ok) return { usable: false, reason: cred.reason, launchKind: "cli", cliInstalled: true };
    return { usable: true, launchKind: "cli", cliInstalled: true };
  }

  // 3. Direct-API providers: require a compatible runtime + stored credential.
  return evaluateDirectApi(adapter, metadata, deps);
}

/** Kept for the Launcher, which only needs the usable/reason pair. */
export async function computeProviderUsability(
  adapter: ProviderAdapter,
  metadata: ProviderAuthMetadata,
  deps: UsabilityDeps,
): Promise<{ usable: boolean; reason?: string }> {
  const evaluation = await evaluateProvider(adapter, metadata, deps);
  return { usable: evaluation.usable, reason: evaluation.reason };
}

async function evaluateDirectApi(
  adapter: ProviderAdapter,
  metadata: ProviderAuthMetadata,
  deps: UsabilityDeps,
): Promise<ProviderEvaluation> {
  const id = adapter.profile.id;
  if (!isDirectApiCompatible(adapter)) {
    return { usable: false, reason: `${id} has no compatible direct-API runtime`, launchKind: "none" };
  }
  if (!metadata.api.supported) {
    return { usable: false, reason: `${id} declares no usable auth`, launchKind: "none" };
  }
  const cred = await checkCredentials(id, metadata, deps);
  if (!cred.ok) return { usable: false, reason: cred.reason, launchKind: "direct-api" };
  return { usable: true, launchKind: "direct-api" };
}

/**
 * The generic API agent (`createApiRunner` + `buildAuthHeaders`) supports both
 * wire protocols and every auth kind except `cli-session` (which throws — a
 * cli-session provider can only be reached through its CLI, never a direct call).
 */
function isDirectApiCompatible(adapter: ProviderAdapter): boolean {
  return adapter.profile.auth.kind !== "cli-session";
}

async function checkCredentials(
  id: string,
  metadata: ProviderAuthMetadata,
  deps: UsabilityDeps,
): Promise<{ ok: boolean; reason?: string }> {
  if (metadata.api.supported) {
    const has = await deps.credentialManager.hasCredential(id, "api-key");
    if (!has) return { ok: false, reason: `${id} has no stored API key` };
  }
  if (metadata.proxyUserKey?.supported) {
    const hasProxy =
      (await deps.credentialManager.hasCredential(id, metadata.proxyUserKey.credentialName)) ||
      !!process.env[metadata.proxyUserKey.envVar];
    if (!hasProxy) return { ok: false, reason: `${id} has no proxy user key` };
  }
  if (!metadata.api.supported && !metadata.proxyUserKey?.supported) {
    return { ok: false, reason: `${id} declares no usable auth` };
  }
  return { ok: true };
}
