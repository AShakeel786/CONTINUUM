/**
 * Platform-aware Docker Desktop discovery.
 *
 * macOS/linux have no GUI launcher executable we can spawn directly — the
 * existing `open -a Docker` path covers them. Windows installs are discoverable
 * from the standard install roots plus a derivation from the docker CLI found
 * on PATH (per-user Docker Desktop installs put the CLI at
 * `<root>\resources\bin\docker.exe`, with the app one level up). The winner is
 * the first candidate that exists, preferring the per-user install (the modern
 * Docker Desktop default) over the all-users Program Files path.
 */
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
// These are always Windows filesystem paths (the function early-returns for
// every other platform), so build them with Windows semantics regardless of
// the host OS running the code — otherwise discovery is only correct when the
// dev machine is also Windows.
import { win32 as winpath } from "node:path";

export interface DockerDesktopDiscoveryDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly exists: (p: string) => boolean;
  readonly findOnPath: (exe: string) => string | undefined;
}

export function discoverDockerDesktop(deps: DockerDesktopDiscoveryDeps): string | undefined {
  if (deps.platform !== "win32") return undefined;
  const candidates: string[] = [];
  const local = deps.env.LOCALAPPDATA;
  if (local) candidates.push(winpath.join(local, "Programs", "DockerDesktop", "Docker Desktop.exe"));
  for (const root of [deps.env.ProgramFiles, deps.env.ProgramW6432]) {
    if (root) candidates.push(winpath.join(root, "Docker", "Docker", "Docker Desktop.exe"));
  }
  const cli = deps.findOnPath("docker");
  if (cli) candidates.push(winpath.join(winpath.dirname(cli), "..", "..", "Docker Desktop.exe"));
  return candidates.find((c) => deps.exists(c));
}

function dockerCliOnPath(exe: string): string | undefined {
  const extensions = [".exe", ".cmd", ".bat"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const p = winpath.join(dir, exe + ext);
      try {
        if (existsSync(p)) return p;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

/** Live discovery: read the real machine (env, PATH, filesystem). Never throws. */
export const defaultDockerDesktopDiscovery = (): Promise<string | undefined> =>
  Promise.resolve(
    discoverDockerDesktop({
      platform: process.platform,
      env: process.env,
      exists: (p) => {
        try {
          return existsSync(p);
        } catch {
          return false;
        }
      },
      findOnPath: dockerCliOnPath,
    }),
  );
