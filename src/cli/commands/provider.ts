/**
 * `continuum provider` — add/list/show/remove/validate user provider manifests.
 * Providers are described by secret-free JSON manifests under
 * `~/.continuum/providers/`; credentials stay in CredentialManager (env-var
 * name only, never a key). Adding a provider never requires editing source,
 * YAML, or .env — just the practical fields below.
 */

import { readFile } from "node:fs/promises";
import { noopOutput } from "../../auth/prompt.js";
import { resolveDataDir } from "../../config/paths.js";
import {
  bundledManifests,
  loadUserManifests,
  saveUserManifest,
  deleteUserManifest,
  validateManifest,
  MANIFEST_SCHEMA_VERSION,
  type ProviderManifest,
} from "../../providers/index.js";
import type { CliIo } from "../index.js";

function opt(args: readonly string[], ...flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]!) && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

const BUNDLED_IDS = new Set(bundledManifests.map((m) => m.id));

export async function runProviderCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const [sub, ...rest] = args;

  switch (sub) {
    case "add":
      return addProvider(rest, out);
    case "list":
      return listProviders(out);
    case "show":
      return showProvider(rest, out);
    case "remove":
    case "rm":
      return removeProvider(rest, out);
    case "validate":
      return validateProvider(rest, out);
    default:
      out("Usage: continuum provider <add|list|show|remove|validate>\n");
      return 2;
  }
}

async function addProvider(args: readonly string[], out: (s: string) => void): Promise<number> {
  const id = opt(args, "--id")?.trim().toLowerCase();
  const displayName = opt(args, "--name")?.trim() || id;
  const protocol = opt(args, "--protocol") as "openai-compatible" | "anthropic-messages" | undefined;
  const baseUrl = opt(args, "--base-url")?.trim();
  const auth = opt(args, "--auth") as "api-key" | "bearer-token" | "cli-session" | undefined;
  const envVar = opt(args, "--env")?.trim();
  const model = opt(args, "--model")?.trim();
  const cliExecutable = opt(args, "--cli")?.trim();

  if (!id || !protocol || !baseUrl || !auth || !model) {
    out("Usage: continuum provider add --id <id> --protocol <openai-compatible|anthropic-messages> --base-url <url> --auth <api-key|bearer-token|cli-session> [--env <VAR>] --model <model> [--cli <exe>]\n");
    return 2;
  }
  if (BUNDLED_IDS.has(id)) {
    out(`"${id}" is a bundled provider id — choose a different id.\n`);
    return 2;
  }
  if ((auth === "api-key" || auth === "bearer-token") && !envVar) {
    out(`--env <VAR> is required for auth ${auth} (the env-var NAME, never a key).\n`);
    return 2;
  }

  const manifest: ProviderManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: id!,
    displayName: displayName!,
    protocol: protocol!,
    baseUrl: baseUrl!,
    auth:
      auth === "api-key"
        ? { kind: "api-key", envVar: envVar! }
        : auth === "bearer-token"
          ? { kind: "bearer-token", envVar: envVar! }
          : { kind: "cli-session" },
    models: { default: model! },
    ...(cliExecutable
      ? {
          cli: {
            supported: true as const,
            executable: cliExecutable,
            versionArgs: ["--version"],
            loginArgs: ["login"],
            logoutArgs: ["logout"],
          },
        }
      : {}),
  };

  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    for (const e of errors) out(`  !! ${e}\n`);
    return 2;
  }
  await saveUserManifest(manifest, resolveDataDir());
  out(`Added provider "${manifest.id}" (${manifest.displayName}). Run "continuum auth ${manifest.id}" to store its credential.\n`);
  return 0;
}

async function listProviders(out: (s: string) => void): Promise<number> {
  const { manifests } = await loadUserManifests(resolveDataDir());
  out("Bundled:\n");
  for (const m of bundledManifests) out(`  ${m.id} [${m.protocol}] ${m.displayName}\n`);
  out("User-defined:\n");
  if (manifests.length === 0) out("  (none)\n");
  for (const m of manifests) out(`  ${m.id} [${m.protocol}] ${m.displayName}\n`);
  return 0;
}

async function showProvider(args: readonly string[], out: (s: string) => void): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) {
    out("Usage: continuum provider show <id>\n");
    return 2;
  }
  const bundled = bundledManifests.find((m) => m.id === id);
  const { manifests } = await loadUserManifests(resolveDataDir());
  const user = manifests.find((m) => m.id === id);
  const m = bundled ?? user;
  if (!m) {
    out(`Unknown provider "${id}".\n`);
    return 2;
  }
  out(`${JSON.stringify(m, null, 2)}\n`);
  return 0;
}

async function removeProvider(args: readonly string[], out: (s: string) => void): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) {
    out("Usage: continuum provider remove <id>\n");
    return 2;
  }
  if (BUNDLED_IDS.has(id)) {
    out(`"${id}" is a bundled provider and cannot be removed.\n`);
    return 2;
  }
  const removed = await deleteUserManifest(id, resolveDataDir());
  out(removed ? `Removed provider "${id}".\n` : `Provider "${id}" not found.\n`);
  return 0;
}

async function validateProvider(args: readonly string[], out: (s: string) => void): Promise<number> {
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    out("Usage: continuum provider validate <manifest.json>\n");
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    out(`Could not read/parse manifest: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const errors = validateManifest(parsed);
  if (errors.length === 0) {
    out(`Valid manifest (${(parsed as ProviderManifest).id}).\n`);
    return 0;
  }
  for (const e of errors) out(`  !! ${e}\n`);
  return 1;
}
