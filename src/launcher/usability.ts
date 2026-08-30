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
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { CliAuthManager } from "../auth/cli-auth-manager.js";
import type { CredentialManager } from "../auth/credential-manager.js";
import type { ProviderAuthMetadata } from "../auth/types.js";
import type { LaunchRoute, ProviderAdapter } from "../providers/types.js";
import { missingEndpointParams } from "../providers/endpoint.js";

/** Per-provider usability, including a human-readable display name and (when unusable) a reason. */
export interface ProviderUsability {
  readonly providerId: string;
  readonly displayName: string;
  readonly model: string;
  readonly usable: boolean;
  readonly reason?: string;
  /** Which launch route was evaluated (dual-route providers only). */
  readonly route?: LaunchRoute;
}

/** How CONTINUUM would launch/run this provider. */
export type LaunchKind = "cli" | "direct-api" | "none";

/** Coarse, menu-facing availability state for a provider. */
export type ProviderAvailability = "ready" | "needs-authentication" | "not-installed" | "not-configured" | "unavailable";

export interface ProviderEvaluation {
  readonly usable: boolean;
  readonly reason?: string;
  readonly launchKind: LaunchKind;
  /** For CLI-launchable providers: whether the CLI executable was detected. */
  readonly cliInstalled?: boolean;
  /** For CLI-launchable providers with their own auth adapter: whether the CLI is authenticated. */
  readonly cliAuthenticated?: boolean;
  /** Which launch route was evaluated (dual-route providers only). */
  readonly route?: LaunchRoute;
}

export interface UsabilityDeps {
  readonly cliAuthManager: CliAuthManager;
  readonly credentialManager: CredentialManager;
  /** Overridable in tests; defaults to a PATH/absolute-path lookup. */
  readonly findExecutable?: (executable: string) => string | undefined;
  /** For dual-route providers: which route to evaluate (default "direct"). */
  readonly route?: LaunchRoute;
}

/**
 * Map an evaluation to a coarse, actionable menu state. "needs-authentication"
 * means the provider is installed but its own CLI login is missing (fixable via
 * a sign-in flow); "not-configured" means a credential/config is missing;
 * "not-installed" means the CLI binary is absent.
 */
export function availabilityOf(e: ProviderEvaluation): ProviderAvailability {
  if (e.usable) return "ready";
  if (e.cliInstalled === false) return "not-installed";
  if (e.cliAuthenticated === false) return "needs-authentication";
  if (e.launchKind === "none") return "unavailable";
  return "not-configured";
}

/**
 * Well-known home bin directories that are frequently absent from a desktop
 * launcher's (Finder/Spotlight) PATH. `~/.local/bin` is where the Antigravity
 * `agy` installer places the binary, and a macOS GUI-launched process often
 * inherits a minimal PATH that omits it even though the terminal has it. This
 * is a generic, best-effort fallback — not an antigravity-specific hack.
 */
function homeBinDirs(): readonly string[] {
  if (process.platform === "win32") return [];
  const home = homedir();
  return [join(home, ".local", "bin"), join(home, "bin")];
}

/** Best-effort, side-effect-free "is this executable reachable on PATH (or an absolute path, or a well-known home bin dir)?" */
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
    // Fallback: home bin dirs that a GUI-launched process may not have on PATH.
    for (const dir of homeBinDirs()) {
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
  const route = deps.route ?? "direct";

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
  //    DeepSeek, whose `claude` CLI is redirected to a remote endpoint or an
  //    optional proxy): the declared launch executable must be detected, plus
  //    the credential(s) required by the selected route. A provider that also
  //    declares `apiFallback` (GLM Free) is NOT reported unusable when the
  //    CLI executable is missing — the generic direct-API harness is selected
  //    instead, honestly reported with `launchKind: "direct-api"`.
  if (adapter.profile.capabilities.cliAvailable) {
    const executable = adapter.resolveCliLaunch(route).executable;
    const findExecutable = deps.findExecutable ?? findExecutableOnPath;
    const installed = findExecutable(executable) !== undefined;
    if (!installed && adapter.profile.apiFallback) {
      return evaluateDirectApi(adapter, metadata, deps, route);
    }
    if (!installed) {
      return { usable: false, reason: `${id} CLI not installed (${executable} not found)`, launchKind: "cli", cliInstalled: false };
    }
    const cred = await checkCredentials(id, metadata, deps, route);
    if (!cred.ok) return { usable: false, reason: cred.reason, launchKind: "cli", cliInstalled: true, route };
    return { usable: true, launchKind: "cli", cliInstalled: true, route };
  }

  // 3. Direct-API providers: require a compatible runtime + stored credential.
  return evaluateDirectApi(adapter, metadata, deps, route);
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
  route: LaunchRoute,
): Promise<ProviderEvaluation> {
  const id = adapter.profile.id;
  if (!isDirectApiCompatible(adapter)) {
    return { usable: false, reason: `${id} has no compatible direct-API runtime`, launchKind: "none" };
  }
  if (!metadata.api.supported) {
    return { usable: false, reason: `${id} declares no usable auth`, launchKind: "none" };
  }
  const cred = await checkCredentials(id, metadata, deps, route);
  if (!cred.ok) return { usable: false, reason: cred.reason, launchKind: "direct-api", route };
  const missingParams = missingEndpointParams(adapter.profile, process.env);
  if (missingParams.length > 0) {
    return { usable: false, reason: `${id} missing ${missingParams.join(", ")}`, launchKind: "direct-api", route };
  }
  return { usable: true, launchKind: "direct-api", route };
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
  route: LaunchRoute,
): Promise<{ ok: boolean; reason?: string }> {
  // Optional proxy route: only the proxy-local user key is required — the
  // proxy holds the upstream key server-side, so the provider's own API key
  // is irrelevant to a proxy CLI launch (and must not be injected into it).
  if (route === "proxy" && metadata.proxyUserKey?.supported) {
    const hasProxy =
      (await deps.credentialManager.hasCredential(id, metadata.proxyUserKey.credentialName)) ||
      !!process.env[metadata.proxyUserKey.envVar];
    if (!hasProxy) return { ok: false, reason: `${id} has no proxy user key` };
    return { ok: true };
  }

  // Direct route (default): only the provider's own API key is required.
  if (metadata.api.supported) {
    const ref = metadata.api.credentialRef;
    const has = await deps.credentialManager.hasCredential(ref.providerId, ref.name);
    if (!has) {
      const label = ref.label ?? `${id} API`;
      return {
        ok: false,
        reason: ref.setupHint
          ? `${id} has no shared ${label} credential. ${ref.setupHint}`
          : `${id} has no stored API key. Run "continuum auth ${id}" to configure it.`,
      };
    }
  }
  if (!metadata.api.supported && !metadata.proxyUserKey?.supported) {
    return { ok: false, reason: `${id} declares no usable auth` };
  }
  return { ok: true };
}
