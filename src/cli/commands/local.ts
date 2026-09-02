/**
 * `continuum local <status|stop> [<provider>]`
 *
 * Inspect and control the CONTINUUM-managed local inference servers that back
 * `localService` providers. `status` reports whether a server is running
 * (CONTINUUM-owned, foreign, or stopped) and healthy. `stop` signals ONLY a
 * server CONTINUUM started — a foreign process holding the port is reported
 * and left untouched.
 *
 * The lifecycle engine is provider-agnostic (`src/local-service/`); this
 * command just resolves the provider's declarative `localService` block into
 * a descriptor and calls the manager.
 */

import { noopOutput } from "../../auth/prompt.js";
import { loadUserManifests } from "../../providers/manifest-store.js";
import { createProviderRegistry } from "../../providers/index.js";
import { resolveDataDir } from "../../config/paths.js";
import { LocalServiceManager } from "../../local-service/manager.js";
import { resolveLocalServiceDescriptor } from "../../local-service/descriptor.js";
import type { ProviderProfile } from "../../providers/types.js";
import type { CliIo } from "../index.js";

const USAGE = "Usage: continuum local <status|stop> [<provider>]\n";

function localProviders(profiles: readonly ProviderProfile[]): ProviderProfile[] {
  return profiles.filter((p) => p.localService !== undefined);
}

export async function runLocalCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const sub = args[0];
  if (sub !== "status" && sub !== "stop") {
    out(USAGE);
    return sub === undefined ? 0 : 2;
  }

  const dataDir = resolveDataDir();
  const { manifests } = await loadUserManifests(dataDir);
  const registry = createProviderRegistry(manifests);
  const candidates = localProviders(registry.listProfiles());

  if (candidates.length === 0) {
    out("No provider declares a managed local service.\n");
    return 0;
  }

  const key = args[1];
  let profile: ProviderProfile | undefined;
  if (key) {
    profile = candidates.find((p) => p.id === key || (p.idAliases ?? []).includes(key));
    if (!profile) {
      out(`No managed-local provider "${key}". Known: ${candidates.map((p) => p.id).join(", ")}\n`);
      return 2;
    }
  } else if (candidates.length === 1) {
    profile = candidates[0];
  } else {
    out(`Multiple managed-local providers — name one: ${candidates.map((p) => p.id).join(", ")}\n`);
    return 2;
  }

  const descriptor = resolveLocalServiceDescriptor(profile!);
  if (!descriptor) {
    out(`Provider "${profile!.id}" has an unresolvable localService block.\n`);
    return 2;
  }

  const manager = new LocalServiceManager({ dataDir });

  if (sub === "status") {
    const status = await manager.status(descriptor);
    out(`${status.providerId}  [${status.state}]\n`);
    out(`  endpoint : http://${status.host}:${status.port}${descriptor.healthPath}\n`);
    out(`  healthy  : ${status.healthy ? "yes" : "no"}\n`);
    if (status.pid !== undefined) out(`  pid      : ${status.pid}\n`);
    if (status.model) out(`  model    : ${status.model}\n`);
    if (status.startedAt) out(`  started  : ${status.startedAt}\n`);
    if (status.logFile) out(`  log      : ${status.logFile}\n`);
    out(`  ${status.detail}\n`);
    return status.state === "stopped" ? 1 : 0;
  }

  // stop
  const result = await manager.stop(descriptor);
  out(`${result.detail}\n`);
  return 0;
}
