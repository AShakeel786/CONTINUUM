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
import { resolveSecret, type SecretRef } from "./secrets.js";
import type {
  CliLaunchContext,
  CliLaunchDescriptor,
  CliLaunchPlan,
  LaunchRoute,
  ModelTierMap,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderProfile,
} from "./types.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveSecretFromCtx(providerId: string, ref: SecretRef, ctx?: CliLaunchContext): string {
  // Prefer the caller-injected secret env (credential backend), falling back
  // to process.env — so a launcher can source the proxy key from
  // CredentialManager without a manual export, while a bare adapter still
  // reads the environment exactly as before.
  return resolveSecret(providerId, ref, ctx?.secrets ?? process.env);
}

export function createProviderAdapter(profile: ProviderProfile): ProviderAdapter {
  return new DataDrivenProviderAdapter(profile);
}

class DataDrivenProviderAdapter implements ProviderAdapter {
  constructor(readonly profile: ProviderProfile) {}

  resolveModel(alias?: string, knownIds?: ReadonlySet<string>): string {
    if (!alias || alias === "default") return this.profile.models.default;
    if (alias === this.profile.models.default || Object.values(this.profile.models.aliases ?? {}).includes(alias)) return alias;
    const mapped = this.profile.models.aliases?.[alias];
    if (mapped) return mapped;
    // A live model id discovered from the installed CLI passes through verbatim
    // (never silently remapped or dropped); anything else is an unknown alias.
    if (knownIds?.has(alias)) return alias;
    throw new UnknownModelAliasError(this.profile.id, alias, Object.keys(this.profile.models.aliases ?? {}));
  }

  resolveCliLaunch(route?: LaunchRoute): CliLaunchDescriptor {
    if (route === "proxy" && this.profile.proxyCliLaunch) return this.profile.proxyCliLaunch;
    return this.profile.cliLaunch;
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
    const launch = this.resolveCliLaunch(ctx.route);
    // Order matters on two counts:
    //   - Model/permission args come FIRST so they precede any subcommand —
    //     Codex parses top-level options (`-m`, `--dangerously-bypass-...`)
    //     only before the `resume` subcommand, never after its session id.
    //   - The MCP flag is variadic (`--mcp-config <configs...>`), so it must be
    //     followed by a flag (the system-prompt flag), never by the positional
    //     task prompt — otherwise the prompt would be swallowed as a config path.
    // Hence: model args → permission args → session args → mcp args → context args.
    const args = [...this.modelArgs(launch, ctx), ...this.permissionArgs(launch, ctx), ...this.sessionArgs(launch, ctx), ...this.mcpArgs(launch, ctx), ...this.statusLineArgs(launch, ctx), ...this.contextArgs(launch, ctx)];
    switch (launch.kind) {
      case "native":
        return {
          executable: launch.executable,
          args,
          // Deliberately empty: relies on the CLI's own persisted login
          // (e.g. `claude`'s own auth), matching the existing native-Claude
          // launcher path, which never injects ANTHROPIC_API_KEY itself.
          env: {},
          clearEnvVars: launch.clearEnvVars,
          configDir: launch.configDirName,
        };
      case "redirected": {
        let token: string;
        try {
          token = resolveSecretFromCtx(this.profile.id, launch.authTokenSecret, ctx);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new ProviderAuthError(this.profile.id, `cannot launch redirected session: ${reason}`);
        }
        return {
          executable: launch.executable,
          args,
          env: {
            ANTHROPIC_BASE_URL: launch.baseUrl,
            ANTHROPIC_AUTH_TOKEN: token,
            ...(launch.statusLineCommand ? { CONTINUUM_STATUS_PROVIDER: this.profile.displayName, CONTINUUM_STATUS_MODEL: this.resolveModel(ctx.modelAlias), CONTINUUM_STATUS_HANDOFF: "ready" } : {}),
            ...this.modelIdentityEnv(launch.modelTierMap, ctx),
          },
          clearEnvVars: launch.clearEnvVars,
          configDir: launch.configDirName,
        };
      }
      case "proxy-routed": {
        let token: string;
        try {
          token = resolveSecretFromCtx(this.profile.id, launch.proxyUserKeySecret, ctx);
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
          args,
          env: {
            ANTHROPIC_BASE_URL: `${launch.proxyBaseUrl}${launch.proxyPathSuffix}`,
            ANTHROPIC_AUTH_TOKEN: token,
            ...(launch.statusLineCommand ? { CONTINUUM_STATUS_PROVIDER: this.profile.displayName, CONTINUUM_STATUS_MODEL: this.resolveModel(ctx.modelAlias), CONTINUUM_STATUS_HANDOFF: "ready" } : {}),
            ...this.modelIdentityEnv(launch.modelTierMap, ctx),
          },
          clearEnvVars: launch.clearEnvVars,
          configDir: launch.configDirName,
        };
      }
    }
  }

  /**
   * Model-identity env for a `redirected`/`proxy-routed` launch: the Claude
   * Code binary is pointed at a third-party endpoint, but without these it
   * still reports/uses Anthropic's own default tier models internally
   * (visibly, in its own UI, and for subagent/background calls it makes on
   * its own) — the exact mechanism behind a DeepSeek session showing "Opus
   * 5" while every request actually goes to DeepSeek. `ANTHROPIC_MODEL`
   * (the primary/visible model) stays a recognized Claude catalog alias;
   * `modelOverrides` maps that alias to the selected provider model on the
   * wire. Tier vars are only set when the profile declares a `modelTierMap`
   * (native launches never get any of this — Anthropic's own tiers are
   * correct there).
   */
  private modelIdentityEnv(tierMap: ModelTierMap | undefined, ctx: CliLaunchContext): Record<string, string> {
    const resolvedPrimary = this.resolveModel(ctx.modelAlias);
    // Claude Code validates ANTHROPIC_MODEL against its own catalog. Keep the
    // client-facing alias recognized while routing the selected alias through
    // the provider-specific tier variable; DeepSeek still receives the real
    // V4 model in the request body, but no longer emits an unrecognized-model
    // warning for its provider model id.
    const env: Record<string, string> = { ANTHROPIC_MODEL: "sonnet" };
    // Keep Claude's catalog-facing values recognized. The supported
    // modelOverrides setting below maps these IDs to the actual provider
    // model sent over the redirected API connection.
    if (tierMap?.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-5";
    if (tierMap?.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-5";
    if (tierMap?.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5";
    if (tierMap?.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = "claude-sonnet-5";
    return env;
  }

  /**
   * Explicit model selection for native CLIs that declare a `modelFlag`
   * (Codex `-m`, agy `--model`). Emitted on BOTH fresh and resume launches so
   * an explicitly selected model always reaches the CLI (never silently
   * ignored). Resolves the same way every other model reference does, so a
   * live-discovered model id passes through via `knownModelIds`.
   */
  private modelArgs(launch: CliLaunchDescriptor, ctx: CliLaunchContext): readonly string[] {
    if (launch.kind !== "native" || !launch.modelFlag) return [];
    return [launch.modelFlag, this.resolveModel(ctx.modelAlias, ctx.knownModelIds)];
  }

  /**
   * Full-access flag for native CLIs that declare a `permissionBypassFlag`.
   * Emitted only when the caller requests `permissionMode: "bypass"`; safe
   * mode (and providers with no declared flag) add nothing. Never emulated.
   */
  private permissionArgs(launch: CliLaunchDescriptor, ctx: CliLaunchContext): readonly string[] {
    if (launch.kind !== "native" || ctx.permissionMode !== "bypass" || !launch.permissionBypassFlag) return [];
    return [launch.permissionBypassFlag];
  }

  /**
   * Build the native-session args from the declared capability + the requested
   * session identity. Resume takes precedence; otherwise a deterministic
   * session-id flag is used when declared. Returns [] when unsupported or
   * nothing is requested — the launcher then starts a fresh native session
   * (resume-brief fallback). No provider-id switch: this reads only the
   * declared `nativeResume` data.
   */
  private sessionArgs(launch: CliLaunchDescriptor, ctx: CliLaunchContext): readonly string[] {
    const nr = launch.nativeResume;
    if (!nr || !nr.supported) return [];
    if (ctx.resumeNativeSessionId) {
      return nr.resume.kind === "flag"
        ? [nr.resume.flag, ctx.resumeNativeSessionId]
        : [nr.resume.subcommand, ctx.resumeNativeSessionId];
    }
    if (ctx.setSessionId && nr.sessionIdFlag) {
      return [nr.sessionIdFlag, ctx.setSessionId];
    }
    return [];
  }

  /**
   * Hand the CONTINUUM MCP server config to the CLI via its declared
   * `mcpLaunch` supply mechanism. Reads only the `McpLaunchSupply` data —
   * never a provider id. `global-config` (Codex) adds nothing; a
   * `mcp-config-flag` (Claude-family) adds `--mcp-config <json>` when the
   * launcher supplied a secret-free server config.
   */
  private mcpArgs(launch: CliLaunchDescriptor, ctx: CliLaunchContext): readonly string[] {
    const supply = launch.mcpLaunch;
    if (!supply || supply.kind !== "mcp-config-flag") return [];
    if (!ctx.mcpConfig) return [];
    return [supply.flag, ctx.mcpConfig];
  }

  /** Claude Code's supported statusLine setting is a persistent in-TUI HUD. */
  private statusLineArgs(launch: CliLaunchDescriptor, ctx: CliLaunchContext): readonly string[] {
    if (launch.kind === "native" || !launch.statusLineCommand) return [];
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const script = join(root, "scripts", "continuum-statusline.mjs");
    const command = `${process.execPath} ${JSON.stringify(script)}`;
    return ["--settings", JSON.stringify({
      statusLine: { type: "command", command, refreshInterval: 5, padding: 0 },
      // Claude validates these catalog IDs locally, then uses the documented
      // provider override as the wire model. This preserves correct context
      // metadata without exposing DeepSeek IDs to the catalog validator.
      modelOverrides: {
        "claude-sonnet-5": this.resolveModel(ctx.modelAlias),
        "claude-opus-5": this.resolveModel("flash"),
        "claude-haiku-4-5": this.resolveModel("flash"),
      },
    })];
  }

  /**
   * Render the task prompt + assembled context into the CLI's own injection
   * surface, per the profile's declared `contextDelivery` mechanism. Reads
   * only the `ContextDelivery` data — never a provider id. Returns [] when no
   * task prompt was supplied (so a bare launch plan with no goal still has
   * exactly its session args, preserving existing behavior).
   */
  private contextArgs(launch: CliLaunchDescriptor, ctx: CliLaunchContext): readonly string[] {
    const delivery = launch.contextDelivery;
    const task = ctx.taskPrompt;
    if (!delivery || !task) return [];
    const system = (ctx.contextSystem ?? "").trim();

    switch (delivery.kind) {
      case "append-system-prompt": {
        const out: string[] = [];
        // The system/context block is appended only when non-empty; the task
        // goal is always the positional prompt.
        if (system.length > 0) out.push(delivery.systemFlag, system);
        out.push(task);
        return out;
      }
      case "prompt-only": {
        // Codex has no system-prompt flag: fold the compact context ahead of
        // the task goal in the single positional prompt.
        return [system.length > 0 ? `${system}\n\n${task}` : task];
      }
    }
  }

  getCapabilities(): ProviderCapabilities {
    return this.profile.capabilities;
  }
}
