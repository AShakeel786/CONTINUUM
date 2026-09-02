/**
 * Resolve a provider profile's declarative `localService` block into a
 * concrete `LocalServiceDescriptor` — host/port derived from the provider's
 * own `baseUrl` when not stated, `${model}`/`${host}`/`${port}` placeholders
 * substituted, sensible OpenAI-compatible defaults for the health path and
 * startup budget. No provider-specific branching.
 */

import type { ProviderProfile } from "../providers/types.js";
import type { LocalServiceDescriptor } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_STARTUP_TIMEOUT_SEC = 120;

export function resolveLocalServiceDescriptor(profile: ProviderProfile): LocalServiceDescriptor | undefined {
  const ls = profile.localService;
  if (!ls) return undefined;

  let host = ls.host?.trim() || DEFAULT_HOST;
  let port = ls.port;
  let basePath = "/v1";
  try {
    const u = new URL(profile.baseUrl);
    if (!ls.host && u.hostname) host = u.hostname;
    if (port === undefined && u.port) port = Number(u.port);
    basePath = u.pathname.replace(/\/+$/, "") || "";
  } catch {
    /* baseUrl is validated at manifest load; fall back to defaults */
  }
  if (port === undefined || !Number.isFinite(port)) port = DEFAULT_PORT;

  const model = ls.model?.trim() || profile.models.default;
  const subst = (s: string): string =>
    s.replaceAll("${model}", model).replaceAll("${host}", host).replaceAll("${port}", String(port));

  return {
    providerId: profile.id,
    command: ls.command,
    args: ls.args.map(subst),
    host,
    port,
    healthPath: ls.healthPath?.trim() || `${basePath}/models` || "/v1/models",
    startupTimeoutSec: ls.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC,
    ...(ls.cwd ? { cwd: subst(ls.cwd) } : {}),
    ...(ls.env ? { env: ls.env } : {}),
    model,
  };
}
