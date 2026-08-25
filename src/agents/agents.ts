/**
 * AI-agent management — a thin, data-driven orchestration layer over the
 * existing systems, so both the interactive menu and tests drive add/remove/
 * list/configure through one place. It holds NO new registry: provider
 * identity lives in the bundled/user manifest graph (`providers/`), auth
 * config references live in `~/.continuum/config.json` (`config/`), and
 * secret values live in `CredentialManager`.
 *
 * A "reload" re-reads user manifests and rebuilds the provider/auth graph, so
 * a newly added/removed agent is visible immediately without restarting.
 */

import { ProviderSetup } from "../auth/provider-setup.js";
import { AuthVerifier } from "../auth/auth-verifier.js";
import { createProviderAuthMetadata, createCliAuthManager } from "../auth/provider-auth/index.js";
import { createProviderRegistry } from "../providers/index.js";
import {
  loadUserManifests,
  saveUserManifest,
  deleteUserManifest,
  validateManifest,
  MANIFEST_SCHEMA_VERSION,
  bundledManifests,
  type ProviderManifest,
} from "../providers/index.js";
import type { CliAuthManager } from "../auth/cli-auth-manager.js";
import type { CredentialManager } from "../auth/credential-manager.js";
import type { ProviderAuthMetadata } from "../auth/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ConfigStore } from "../config/store.js";
import type { ProviderAuthMethod } from "../config/types.js";
import type { Prompt, PromptOutput } from "../auth/prompt.js";
import { UnknownProviderError } from "../providers/errors.js";
import { availabilityOf, evaluateProvider, type LaunchKind, type ProviderAvailability, type ProviderUsability } from "../launcher/usability.js";
import { InvalidCredentialError } from "../auth/errors.js";
import { AgentValidationError } from "./errors.js";
import { formatPromoLabel } from "../providers/promo.js";

export type { ProviderUsability };

export interface AgentAuthFacts {
  readonly api: boolean;
  readonly cli: boolean;
  readonly proxyUserKey: boolean;
}

export interface AgentDescriptor {
  readonly providerId: string;
  readonly displayName: string;
  readonly source: "builtin" | "user";
  readonly auth: AgentAuthFacts;
  readonly configured: boolean;
  readonly configuredMethod?: "api" | "cli";
  /** How CONTINUUM would launch/run this provider (cli / direct-api / none). */
  readonly launchKind: LaunchKind;
  readonly cliInstalled?: boolean;
  readonly cliAuthenticated?: boolean;
  /** Which launch route this provider uses (dual-route providers only). */
  readonly route?: "direct" | "proxy";
  /** Coarse menu-facing state (ready / needs-authentication / not-installed / …). */
  readonly availability: ProviderAvailability;
  readonly usable: boolean;
  readonly reason?: string;
  /** Active temporary/promotional label (e.g. `FREE (until Aug 27)`); absent when no active promo. */
  readonly promo?: string;
}

export interface CustomAgentInput {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: "openai-compatible" | "anthropic-messages";
  readonly baseUrl: string;
  readonly auth: "api-key" | "bearer-token" | "cli-session";
  readonly envVar?: string;
  readonly model: string;
  readonly cliExecutable?: string;
  readonly cliLoginArgs?: readonly string[];
  readonly cliLogoutArgs?: readonly string[];
  readonly cliStatusArgs?: readonly string[];
  readonly cliVersionArgs?: readonly string[];
}

export interface AgentRemovalResult {
  readonly providerId: string;
  readonly removedConfigEntry: boolean;
  readonly removedManifest: boolean;
}

export interface AgentManagerDeps {
  readonly dataDir: string;
  readonly configStore: ConfigStore;
  readonly credentialManager: CredentialManager;
  readonly prompt: Prompt;
  readonly output?: PromptOutput;
  /** Overridable in tests so no real CLI is ever spawned; defaults to the real manager. */
  readonly buildCliAuthManager?: (manifests: readonly ProviderManifest[]) => CliAuthManager;
  /** Overridable in tests to control CLI-executable detection (external-CLI providers like DeepSeek). */
  readonly findExecutable?: (executable: string) => string | undefined;
}

const BUNDLED_IDS = new Set(bundledManifests.map((m) => m.id));

function buildCustomManifest(input: CustomAgentInput): ProviderManifest {
  const auth: ProviderManifest["auth"] =
    input.auth === "cli-session"
      ? { kind: "cli-session" }
      : { kind: input.auth, envVar: input.envVar! };
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: input.id,
    displayName: input.displayName,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    auth,
    models: { default: input.model },
    ...(input.cliExecutable
      ? {
          cli: {
            supported: true as const,
            executable: input.cliExecutable,
            versionArgs: input.cliVersionArgs ?? ["--version"],
            loginArgs: input.cliLoginArgs ?? ["login"],
            ...(input.cliLogoutArgs ? { logoutArgs: input.cliLogoutArgs } : {}),
            ...(input.cliStatusArgs ? { statusArgs: input.cliStatusArgs } : {}),
          },
        }
      : {}),
  };
}

export class AgentManager {
  private providers!: ProviderRegistry;
  private authMetadata!: ReadonlyMap<string, ProviderAuthMetadata>;
  private cliAuthManager!: CliAuthManager;

  constructor(private readonly deps: AgentManagerDeps) {}

  private get out(): PromptOutput {
    return this.deps.output ?? (() => {});
  }

  /** Re-read user manifests and rebuild the provider/auth graph. */
  async reload(): Promise<void> {
    const { manifests: userManifests } = await loadUserManifests(this.deps.dataDir);
    this.providers = createProviderRegistry(userManifests);
    this.authMetadata = createProviderAuthMetadata(userManifests);
    this.cliAuthManager = this.deps.buildCliAuthManager
      ? this.deps.buildCliAuthManager(userManifests)
      : createCliAuthManager(userManifests);
  }

  /** Fresh list of all known agents (bundled + user), each with live status. */
  async listDescriptors(): Promise<readonly AgentDescriptor[]> {
    await this.reload();
    return this.describe();
  }

  /** Fresh list of usable providers — the same shape the Launcher's picker uses. */
  async listUsable(): Promise<readonly ProviderUsability[]> {
    await this.reload();
    const config = await this.deps.configStore.load();
    const out: ProviderUsability[] = [];
    for (const id of this.providers.listIds()) {
      const adapter = this.providers.get(id);
      const metadata = this.authMetadata.get(id);
      if (!metadata) continue;
      const route = this.routeFor(config, id);
      const evaluation = await evaluateProvider(adapter, metadata, {
        cliAuthManager: this.cliAuthManager,
        credentialManager: this.deps.credentialManager,
        findExecutable: this.deps.findExecutable,
        route,
      });
      out.push({
        providerId: id,
        displayName: adapter.profile.displayName,
        model: adapter.resolveModel(),
        usable: evaluation.usable,
        reason: evaluation.reason,
        route,
      });
    }
    return out;
  }

  /** Resolve the launch route for a provider (direct default; proxy only when configured). */
  private routeFor(config: import("../config/types.js").ContinuumConfig, providerId: string): "direct" | "proxy" {
    return config.proxyRouting?.[providerId] ?? "direct";
  }

  /** The current set of known provider ids (fresh). */
  async knownIds(): Promise<ReadonlySet<string>> {
    await this.reload();
    return new Set(this.providers.listIds());
  }

  /** Run auth setup for an existing provider and record the config entry (validated first). */
  async add(providerId: string, preferredMethod?: ProviderAuthMethod, route?: "direct" | "proxy"): Promise<AgentDescriptor | undefined> {
    await this.reload();
    const metadata = this.requireMetadata(providerId);
    const configured = await this.setupAndRecord(metadata, preferredMethod, route);
    if (!configured) return undefined;
    return (await this.describe()).find((d) => d.providerId === providerId);
  }

  /** Create + save a custom user manifest, then run its auth setup. */
  async addCustom(input: CustomAgentInput): Promise<AgentDescriptor> {
    const manifest = buildCustomManifest(input);
    const errors = validateManifest(manifest);
    if (errors.length > 0) throw new AgentValidationError(manifest.id, errors.join("; "));
    if (BUNDLED_IDS.has(manifest.id)) throw new AgentValidationError(manifest.id, "that id is reserved for a bundled agent");
    await saveUserManifest(manifest, this.deps.dataDir);
    await this.reload();
    try {
      await this.setupAndRecord(this.requireMetadata(manifest.id));
    } catch (err) {
      // The manifest is saved (the agent exists); surface the auth problem but keep the agent.
      if (err instanceof AgentValidationError) this.out(`(${err.message})\n`);
      else throw err;
    }
    return (await this.describe()).find((d) => d.providerId === manifest.id)!;
  }

  /** (Re)run auth setup for an agent (add/configure share the same path). */
  async configure(providerId: string, preferredMethod?: ProviderAuthMethod, route?: "direct" | "proxy"): Promise<AgentDescriptor | undefined> {
    return this.add(providerId, preferredMethod, route);
  }

  /**
   * Remove an agent's CONTINUUM registration only: its config entry, any
   * CONTINUUM-stored credential (api-key / proxy-user-key), and — for a
   * user-defined agent — its manifest file. Never uninstalls a CLI or touches
   * a third-party CLI's own login (CLI-auth providers store no credential here).
   */
  async remove(providerId: string): Promise<AgentRemovalResult> {
    await this.reload();
    const metadata = this.requireMetadata(providerId);
    const setup = new ProviderSetup({
      credentialManager: this.deps.credentialManager,
      cliAuthManager: this.cliAuthManager,
      prompt: this.deps.prompt,
    });
    await setup.remove(metadata);
    const config = await this.deps.configStore.load();
    const hadEntry = config.providers.some((e) => e.providerId === providerId);
    const next = setup.removeConfigEntry(config, providerId);
    const proxyRouting = { ...(next.proxyRouting ?? {}) };
    delete proxyRouting[providerId];
    await this.deps.configStore.save({ ...next, proxyRouting });
    // Only user-defined agents have a manifest file to remove; bundled agents
    // keep their built-in identity and are simply un-configured here.
    const isUser = !BUNDLED_IDS.has(providerId);
    const removedManifest = isUser && (await deleteUserManifest(providerId, this.deps.dataDir));
    await this.reload();
    return { providerId, removedConfigEntry: hadEntry, removedManifest };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private requireMetadata(providerId: string): ProviderAuthMetadata {
    const metadata = this.authMetadata.get(providerId);
    if (!metadata) throw new UnknownProviderError(providerId, [...this.authMetadata.keys()]);
    return metadata;
  }

  /** Validate-then-save auth for one provider. Returns false when the user cancelled (no API key). */
  private async setupAndRecord(metadata: ProviderAuthMetadata, preferredMethod?: ProviderAuthMethod, route?: "direct" | "proxy"): Promise<boolean> {
    const setup = new ProviderSetup({
      credentialManager: this.deps.credentialManager,
      cliAuthManager: this.cliAuthManager,
      prompt: this.deps.prompt,
    });
    let result: Awaited<ReturnType<typeof setup.setup>>;
    try {
      result = await setup.setup(metadata, preferredMethod);
    } catch (err) {
      if (err instanceof InvalidCredentialError) throw new AgentValidationError(metadata.providerId, err.message);
      throw err;
    }
    if (result.method === "api" && !result.credentialUri) return false;

    // Validate before writing config — never persist a config reference that
    // doesn't actually resolve/authenticate right now.
    const verifier = new AuthVerifier({
      credentialManager: this.deps.credentialManager,
      cliAuthManager: this.cliAuthManager,
    });
    const validation = result.method === "api" ? await verifier.verifyApi(metadata) : await verifier.verifyCli(metadata);
    if (validation.outcome !== "ok") throw new AgentValidationError(metadata.providerId, validation.detail);

    // The optional proxy user key is only collected when the provider is
    // explicitly routed through the proxy — never as a side effect of a normal
    // (direct) setup.
    if (metadata.proxyUserKey?.supported && route === "proxy") {
      await setup.setupProxyUserKey(metadata);
    }

    const config = await this.deps.configStore.load();
    const next = setup.applyConfigEntry(config, metadata.providerId, result.method, result.credentialUri);
    // Persist the explicit routing choice for dual-route providers; absent/other
    // defaults to "direct" (standalone).
    const proxyRouting = { ...(config.proxyRouting ?? {}) };
    if (route === "proxy" && metadata.proxyUserKey?.supported) {
      proxyRouting[metadata.providerId] = "proxy";
    } else {
      delete proxyRouting[metadata.providerId];
    }
    await this.deps.configStore.save({ ...next, proxyRouting });
    return true;
  }

  private async describe(): Promise<readonly AgentDescriptor[]> {
    const config = await this.deps.configStore.load();
    const byId = new Map(config.providers.map((e) => [e.providerId, e]));
    const out: AgentDescriptor[] = [];
    for (const id of this.providers.listIds()) {
      const adapter = this.providers.get(id);
      const metadata = this.authMetadata.get(id);
      if (!metadata) continue;
      const route = this.routeFor(config, id);
      const evaluation = await evaluateProvider(adapter, metadata, {
        cliAuthManager: this.cliAuthManager,
        credentialManager: this.deps.credentialManager,
        findExecutable: this.deps.findExecutable,
        route,
      });
      const entry = byId.get(id);
      out.push({
        providerId: id,
        displayName: adapter.profile.displayName,
        source: BUNDLED_IDS.has(id) ? "builtin" : "user",
        auth: {
          api: metadata.api.supported,
          cli: metadata.cli.supported,
          proxyUserKey: metadata.proxyUserKey?.supported ?? false,
        },
        configured: entry !== undefined,
        configuredMethod: entry?.method,
        launchKind: evaluation.launchKind,
        cliInstalled: evaluation.cliInstalled,
        cliAuthenticated: evaluation.cliAuthenticated,
        route,
        availability: availabilityOf(evaluation),
        usable: evaluation.usable,
        reason: evaluation.reason,
        promo: formatPromoLabel(adapter.profile.promo),
      });
    }
    return out;
  }
}
