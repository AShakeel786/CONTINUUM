/**
 * `continuum project <add|remove|list|show>` — project registry management.
 */

import { ProjectRegistry } from "../../registry/registry.js";
import { normalizeProjectPath } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { resolveDataDir } from "../../config/paths.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { ProjectAlreadyExistsError, ProjectNotFoundError } from "../../registry/errors.js";
import type { CliIo } from "../index.js";

export async function runProjectCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const dataDir = resolveDataDir();
  const project = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const knownProviders = new Set(createDefaultProviderAuthMetadata().keys());

  const [sub, ...rest] = args;

  switch (sub) {
    case undefined:
    case "list": {
      const list = await project.list();
      if (list.length === 0) {
        out("No projects registered.\n");
        return 0;
      }
      for (const p of list) {
        const def = p.defaultProvider ? ` [default: ${p.defaultProvider}${p.defaultModel ? `/${p.defaultModel}` : ""}]` : "";
        const aliases = p.aliases.length ? ` (${p.aliases.join(", ")})` : "";
        out(`- ${p.name}${aliases}${def}\n  ${p.path}\n`);
      }
      return 0;
    }
    case "add": {
      const name = argValue(rest, "--name", "-n") ?? rest[0];
      const p = argValue(rest, "--path", "-p") ?? rest[1];
      if (!name || !p) {
        out("Usage: continuum project add <name> <path> [--alias <a>] [--provider <id>] [--model <m>]\n");
        return 2;
      }
      const aliases = multiArgValues(rest, "--alias", "-a");
      const defaultProvider = argValue(rest, "--provider");
      const defaultModel = argValue(rest, "--model");

      project.validateProvider(defaultProvider, knownProviders);
      try {
        const record = await project.add({
          name,
          path: normalizeProjectPath(p),
          aliases,
          ...(defaultProvider ? { defaultProvider } : {}),
          ...(defaultModel ? { defaultModel } : {}),
        });
        out(`Added project "${record.name}" at ${record.path}.\n`);
        return 0;
      } catch (err) {
        if (err instanceof ProjectAlreadyExistsError) {
          out(`${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
    case "remove":
    case "rm": {
      const key = rest[0];
      if (!key) {
        out("Usage: continuum project remove <name|alias|id>\n");
        return 2;
      }
      try {
        await project.remove(key);
        out(`Removed project "${key}".\n`);
        return 0;
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          out(`${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
    case "show": {
      const key = rest[0] ?? process.cwd();
      try {
        // Prefer an explicit key; otherwise detect from CWD.
        const resolved = rest[0] ? await project.resolve(rest[0]) : await project.detect(process.cwd());
        if (!resolved) {
          out("No project for the current directory.\n");
          return 0;
        }
        out(`${resolved.name}\n  path: ${resolved.path}\n`);
        if (resolved.defaultProvider) out(`  default provider: ${resolved.defaultProvider}\n`);
        if (resolved.aliases.length) out(`  aliases: ${resolved.aliases.join(", ")}\n`);
        return 0;
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          out(`${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
    default:
      out(`Unknown subcommand "${sub}".\n`);
      out("Usage: continuum project <add|remove|list|show>\n");
      return 2;
  }
}

function argValue(args: readonly string[], ...flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]!) && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function multiArgValues(args: readonly string[], ...flags: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]!) && i + 1 < args.length) values.push(args[i + 1]!);
  }
  return values;
}
