/**
 * The generic, data-driven ProviderAdapter. Every behavior here branches on
 * a discriminated union's `kind` (auth strategy, launch mechanism) — never
 * on provider identity. Claude and DeepSeek are proven through this exact
 * same adapter implementation (see profiles/claude.ts, profiles/deepseek.ts);
 * a future provider needs a new `ProviderProfile` object, and only needs new
 * adapter code at all if it requires a genuinely new auth/launch *kind*
 * (rare, and a principled one-time addition, not a per-provider branch).
 */

import { ProviderAuthError, ProviderConfigError, UnknownModelAliasError } from "./errors.js";
import { resolveSecret } from "./secrets.js";
import type {
  CliLaunchContext,
  CliLaunchPlan,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderProfile,
} from "./types.js";

export function createProviderAdapter(profile: ProviderProfile): ProviderAdapter {
  return new DataDrivenProviderAdapter(profile);
}

class DataDrivenProviderAdapter implements ProviderAdapter {
  constructor(readonly profile: ProviderProfile) {}

  resolveModel(alias?: string): string {
    if (!alias || alias === "default") return this.profile.models.default;
    const mapped = this.profile.models.aliases?.[alias];
    if (!mapped) {
      throw new UnknownModelAliasError(this.profile.id, alias, Object.keys(this.profile.models.aliases ?? {}));
    }
    return mapped;
  }

  buildAuthHeaders(): Readonly<Record<string, string>> {
    const auth = this.profile.auth;
    switch (auth.kind) {
      case "api-key": {
        const key = resolveSecret(this.profile.id, auth.secret);
        // Header convention follows the wire protocol, not the auth kind:
        // Anthropic's Messages API wants a raw `x-api-key`; OpenAI-compatible
        // APIs (DeepSeek's native endpoint) want `Authorization: Bearer`.
        return this.profile.protocol === "anthropic-messages"
          ? { "x-api-key": key }
          : { Authorization: `Bearer ${key}` };
      }
      case "bearer-token": {
        const token = resolveSecret(this.profile.id, auth.secret);
        return { Authorization: `Bearer ${token}` };
      }
      case "proxy-routed": {
        const token = resolveSecret(this.profile.id, auth.secret);
        return { Authorization: `Bearer ${token}` };
      }
      case "cli-session":
        // Honest failure, not a fabricated header: this auth kind holds no
        // secret CONTINUUM can use for a direct API call by design (see
        // types.ts CliSessionAuth doc) — only an already-authenticated CLI
        // session can reach this provider.
        throw new ProviderConfigError(
          this.profile.id,
          "auth kind is cli-session — no direct-API credential is available; this provider can only be reached via its authenticated CLI, not a direct call.",
        );
    }
  }

  buildCliLaunchPlan(ctx: CliLaunchContext): CliLaunchPlan {
    const launch = this.profile.cliLaunch;
    switch (launch.kind) {
      case "native":
        return {
          executable: launch.executable,
          args: [],
          // Deliberately empty: relies on the CLI's own persisted login
          // (e.g. `claude`'s own auth), matching the existing native-Claude
          // launcher path, which never injects ANTHROPIC_API_KEY itself.
          env: {},
          clearEnvVars: launch.clearEnvVars,
          configDir: launch.configDirName,
        };
      case "proxy-routed": {
        let token: string;
        try {
          token = resolveSecret(this.profile.id, launch.proxyUserKeySecret);
        } catch (err) {
          // Re-surface as ProviderAuthError here specifically: at CLI-launch
          // time (unlike a direct API call), a missing proxy key means the
          // whole session can't start — a more specific, actionable failure
          // than the generic MissingSecretError alone.
          const reason = err instanceof Error ? err.message : String(err);
          throw new ProviderAuthError(this.profile.id, `cannot launch via proxy: ${reason}`);
        }
        return {
          executable: launch.executable,
          args: [],
          env: {
            ANTHROPIC_BASE_URL: `${launch.proxyBaseUrl}${launch.proxyPathSuffix}`,
            ANTHROPIC_AUTH_TOKEN: token,
          },
          clearEnvVars: launch.clearEnvVars,
          configDir: launch.configDirName,
        };
      }
    }
  }

  getCapabilities(): ProviderCapabilities {
    return this.profile.capabilities;
  }
}
