/**
 * Docker Desktop path discovery (health/docker-desktop.ts) — pure, no I/O:
 * platform + env + PATH + a fake filesystem decide the launchable exe.
 *   darwin/linux     → undefined (the `open -a Docker` path owns those)
 *   win32, no install → undefined
 *   win32, per-user  → %LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe
 *   win32, all-users → %ProgramFiles%\Docker\Docker\Docker Desktop.exe
 *   win32, CLI-only  → derived from the docker CLI found on PATH
 * First existing candidate wins (per-user preferred over all-users).
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { discoverDockerDesktop, type DockerDesktopDiscoveryDeps } from "../docker-desktop.js";

const WIN = "win32";

function deps(overrides?: Partial<DockerDesktopDiscoveryDeps>): DockerDesktopDiscoveryDeps {
  const provided = overrides ?? {};
  // The CLI finder consults the same fake filesystem `exists` does, mirroring
  // the real dockerCliOnPath + existsSync pairing.
  const exists = provided.exists ?? (() => false);
  const findOnPath =
    provided.findOnPath ??
    ((exe: string) => {
      if (exe !== "docker") return undefined;
      for (const dir of ["C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin", "C:\\Windows\\System32"]) {
        for (const ext of [".exe", ".cmd", ".bat"]) {
          const p = join(dir, `docker${ext}`);
          if (exists(p)) return p;
        }
      }
      return undefined;
    });
  return {
    platform: WIN,
    env: {
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      ProgramW6432: "C:\\Program Files",
      PATH: "C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin;C:\\Windows\\System32",
    },
    exists,
    findOnPath,
    ...provided,
  };
}

describe("discoverDockerDesktop", () => {
  it("never returns a path on non-Windows platforms", () => {
    expect(discoverDockerDesktop(deps({ platform: "darwin" }))).toBeUndefined();
    expect(discoverDockerDesktop(deps({ platform: "linux" }))).toBeUndefined();
  });

  it("returns undefined on win32 when nothing is installed", () => {
    expect(discoverDockerDesktop(deps())).toBeUndefined();
  });

  it("prefers the per-user install over Program Files", () => {
    const d = deps({
      exists: (p) =>
        p === "C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe" ||
        p === "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    });
    expect(discoverDockerDesktop(d)).toBe("C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe");
  });

  it("uses the all-users Program Files path when only that exists", () => {
    const d = deps({ exists: (p) => p === "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" });
    expect(discoverDockerDesktop(d)).toBe("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe");
  });

  it("falls back to ProgramW6432 when ProgramFiles is absent", () => {
    const d = deps({
      env: { ...deps().env, ProgramFiles: undefined },
      exists: (p) => p === "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    });
    expect(discoverDockerDesktop(d)).toBe("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe");
  });

  it("derives the app from the docker CLI on PATH when standard roots have no install", () => {
    const d = deps({
      env: {
        LOCALAPPDATA: undefined,
        ProgramFiles: "C:\\Program Files",
        ProgramW6432: undefined,
        PATH: "D:\\Docker\\resources\\bin;",
      },
      findOnPath: (exe) => (exe === "docker" ? "D:\\Docker\\resources\\bin\\docker.exe" : undefined),
      exists: (p) => p === "D:\\Docker\\resources\\bin\\docker.exe" || p === "D:\\Docker\\Docker Desktop.exe",
    });
    expect(discoverDockerDesktop(d)).toBe("D:\\Docker\\Docker Desktop.exe");
  });

  it("ignores an unrelated docker CLI (e.g. WSL shim) with no Desktop beside it", () => {
    const d = deps({ exists: (p) => p === "C:\\Windows\\System32\\docker.exe" });
    expect(discoverDockerDesktop(d)).toBeUndefined();
  });
});
