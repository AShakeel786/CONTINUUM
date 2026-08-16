/**
 * Top-level `continuum setup` orchestration across every registered
 * provider, plus first-run initialization of the `~/.continuum` data
 * directory and credential-backend selection.
 *
 * The wizard's responsibilities are narrow and data-driven:
 *   1. Ensure the data dir exists and select/record the credential backend
 *      (`selectCredentialBackend` — native first, encrypted-file fallback).
 *   2. For each registered provider (in registration order), ask whether to
 *      set it up, then delegate the actual flow to `ProviderSetup`.
 *   3. Persist the resulting config references (never values).
 *
 * It makes no provider-specific decisions — everything it needs is in
 * `ProviderAuthMetadata` (data) and `ProviderSetup` (behavior).
 */

import fsPromises from "node:fs/promises";
import { selectCredentialBackend } from "./backends/detect.js";
import type { CredentialBackend } from "./types.js";
import { CredentialManager } from "./credential-manager.js";
import { ConfigStore } from "../config/store.js";
import { resolveDataDir } from "../config/paths.js";
import { ProviderSetup } from "./provider-setup.js";
import type { CliAuthManager } from "./cli-auth-manager.js";
import type { ProviderAuthMetadata } from "./types.js";
import type { ContinuumConfig } from "../config/types.js";
import type { Prompt, PromptOutput } from "./prompt.js";

export interface SetupWizardDeps {
  readonly prompt: Prompt;
  readonly cliAuthManager: CliAuthManager;
  readonly providerMetadata: ReadonlyMap<string, ProviderAuthMetadata>;
  readonly dataDir?: string;
  readonly output?: PromptOutput;
  /** Passphrase provider for the encrypted-file fallback; only consulted when no native backend works. */
  readonly passphraseProvider?: () => Promise<string>;
  /** When true, non-interactive answers default "no" (skip) rather than blocking. */
  readonly nonInteractive?: boolean;
}

export interface WizardState {
  credentialManager: CredentialManager;
  backend: CredentialBackend;
  backendReason: string;
  config: ContinuumConfig;
}

export class SetupWizard {
  constructor(private readonly deps: SetupWizardDeps) {}

  private get out(): PromptOutput {
    return this.deps.output ?? (() => {});
  }

  /**
   * First-run initialization: ensure data dir, select + record backend,
   * return a `CredentialManager` wired to it. Idempotent — calling twice
   * re-loads the selected backend from config when present.
   */
  async initialize(configStore: ConfigStore, dataDir: string = resolveDataDir()): Promise<WizardState> {
    await fsPromises.mkdir(dataDir, { recursive: true });
    const existing = await configStore.load();

    let backend: CredentialBackend;
    let backendReason: string;
    if (existing.credentialBackendId) {
      const selected = await selectCredentialBackend(this.deps.passphraseProvider ?? (async () => ""), dataDir);
      // If the recorded backend id still resolves, honor it; otherwise the
      // native-first selection already made the right call and we keep it.
      backend = selected.backend;
      backendReason = `previously recorded backend "${existing.credentialBackendId}"` + (selected.backend.id === existing.credentialBackendId ? "" : ` not available; using ${selected.backend.id}`);
    } else {
      const selected = await selectCredentialBackend(this.deps.passphraseProvider ?? (async () => ""), dataDir);
      backend = selected.backend;
      backendReason = selected.reason;
      const updated: ContinuumConfig = { ...existing, credentialBackendId: backend.id, updatedAt: new Date().toISOString() };
      await configStore.save(updated);
    }

    return {
      credentialManager: new CredentialManager(backend),
      backend,
      backendReason,
      config: await configStore.load(),
    };
  }

  /**
   * Walk every registered provider and (interactively) set each up. Returns
   * the final persisted config. Skips providers the user declines; in
   * non-interactive mode it never blocks and skips everything.
   */
  async run(configStore: ConfigStore, state: WizardState): Promise<ContinuumConfig> {
    const providerSetup = new ProviderSetup({
      credentialManager: state.credentialManager,
      cliAuthManager: this.deps.cliAuthManager,
      prompt: this.deps.prompt,
    });

    let config = state.config;

    for (const metadata of this.deps.providerMetadata.values()) {
      const want = this.deps.nonInteractive ? false : await this.deps.prompt.confirm(`Set up ${metadata.providerId} auth?`, false);
      if (!want) continue;
      const result = await providerSetup.setup(metadata);
      if (result.method === "api" && !result.credentialUri) {
        this.out(`Skipped ${metadata.providerId} (no key provided).\n`);
        continue;
      }
      config = providerSetup.applyConfigEntry(config, metadata.providerId, result.method, result.credentialUri);
      this.out(`✓ ${metadata.providerId}: ${result.method === "api" ? "API key stored" : "CLI auth"} (${result.method}).\n`);
    }

    // One-time MCP auto-configure permission (ask only when not yet answered).
    if (config.mcpAutoConfigure === undefined && !this.deps.nonInteractive) {
      const allow = await this.deps.prompt.confirm(
        "Allow CONTINUUM to auto-register its MCP server with installed CLIs (Claude/Codex)?",
        false,
      );
      config = { ...config, mcpAutoConfigure: allow, updatedAt: new Date().toISOString() };
      this.out(`${allow ? "✓" : "✗"} MCP auto-configure: ${allow ? "enabled" : "disabled"}.\n`);
    }

    await configStore.save(config);
    return config;
  }
}
