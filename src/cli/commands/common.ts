/**
 * Shared wiring for CLI commands — builds the dependency graph
 * (config store, credential backend, provider metadata, CLI auth manager,
 * prompt) exactly once, the way a real run does, so command modules don't
 * each re-derive it (and tests can call the same builders).
 */

import { ConfigStore } from "../../config/store.js";
import { resolveDataDir } from "../../config/paths.js";
import { selectCredentialBackend } from "../../auth/backends/detect.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { createProviderAuthMetadata, createCliAuthManager } from "../../auth/provider-auth/index.js";
import { loadUserManifests } from "../../providers/manifest-store.js";
import type { Prompt } from "../../auth/prompt.js";
import type { CredentialBackend } from "../../auth/types.js";
import type { CliAuthManager } from "../../auth/cli-auth-manager.js";
import type { ProviderAuthMetadata } from "../../auth/types.js";
import { setupPassphraseProvider } from "./passphrase.js";

export interface CommandContext {
  readonly configStore: ConfigStore;
  readonly credentialManager: CredentialManager;
  readonly backend: CredentialBackend;
  readonly providerMetadata: ReadonlyMap<string, ProviderAuthMetadata>;
  readonly cliAuthManager: CliAuthManager;
  readonly prompt: Prompt;
  readonly dataDir: string;
}

export interface CommandOptions {
  readonly dataDir?: string;
  readonly prompt: Prompt;
  readonly nonInteractive?: boolean;
  readonly passphraseProvider?: () => Promise<string>;
}

export async function buildContext(options: CommandOptions): Promise<CommandContext> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const configStore = new ConfigStore(dataDir);
  const passphraseProvider = options.passphraseProvider ?? setupPassphraseProvider(options.prompt);
  const selection = await selectCredentialBackend(passphraseProvider, dataDir);
  const credentialManager = new CredentialManager(selection.backend);

  // Load user provider manifests so runtime/auth metadata sees user-defined providers.
  const { manifests: userManifests } = await loadUserManifests(dataDir);

  return {
    configStore,
    credentialManager,
    backend: selection.backend,
    providerMetadata: createProviderAuthMetadata(userManifests),
    cliAuthManager: createCliAuthManager(userManifests),
    prompt: options.prompt,
    dataDir,
  };
}

/**
 * Recording credential-backend selection is *initialization*, not a read:
 * the writing commands (`auth`, `setup`) must persist the selected backend id
 * so a later run (or `doctor`) knows which backend a credential lives in.
 * Read-only commands (`providers`, `doctor`) call `buildContext` but do NOT
 * call this, so they never write. This mirrors what the wizard's
 * `initialize` does, shared here so first-run via `auth` is also consistent.
 */
export async function ensureBackendRecorded(ctx: CommandContext): Promise<void> {
  const config = await ctx.configStore.load();
  if (config.credentialBackendId === ctx.backend.id) return;
  await ctx.configStore.save({ ...config, credentialBackendId: ctx.backend.id, updatedAt: new Date().toISOString() });
}

/** True when stdin is a real interactive terminal (a human can type). */
export function isStdinTty(): boolean {
  return (process.stdin as { isTTY?: boolean }).isTTY === true;
}

/** Best-effort terminal column count; falls back to a sane 80-col default when unavailable (tests, pipes). */
export function getTerminalColumns(): number {
  const cols = process.stdout?.columns;
  return typeof cols === "number" && cols > 0 ? cols : 80;
}

/** Friendly, actionable explanation for commands that need an interactive terminal. */
export const NON_TTY_HINT =
  "The interactive UI needs a terminal. Run a command directly (e.g. `continuum launch <project>`, `continuum sessions`) or see `continuum --help`.";
