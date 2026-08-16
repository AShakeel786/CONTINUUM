/**
 * Real-world adapters that wire the health layer to this machine's stack:
 * node child_process for docker/ps shells, global fetch for HTTP probes, the
 * credential/session/providers modules for the store checks. These adapters
 * are what the CLI constructs; tests inject fakes instead.
 */
import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HealthRuntime } from "./types.js";
import { resolveDataDir } from "../config/paths.js";

/**
 * Canonical Tencent Mac scripts dir. Overridable via `CONTINUUM_TENCENT_MAC_DIR`
 * so a fresh install on a machine without the Tencent repo at the default
 * location can point at its own checkout — never a hard machine-specific path.
 */
export const DEFAULT_TENCENT_MAC_DIR =
  process.env.CONTINUUM_TENCENT_MAC_DIR?.trim() ||
  join(homedir(), "Developer", "Ai-tools", "TencentDB-Agent-Memory", "mac");

export const DEFAULT_OPTIONS = {
  tencentMacDir: DEFAULT_TENCENT_MAC_DIR,
  memoryCoreUrl: process.env.CONTINUUM_MEMORY_CORE_URL ?? "http://127.0.0.1:8420",
  proxyHealthUrl: process.env.CONTINUUM_MEMORY_PROXY_URL ?? "http://127.0.0.1:8096/health",
  containers: {
    memoryCore: "tdai-memory-core",
    proxy: "tdai-proxy",
    hub: "tdai-memory-hub",
  },
  pinnedImage: "agentmemory/memory-core:phase13",
  stateFile: join(resolveDataDir(), "health-state.json"),
  providerExecutables: ["claude", "codex"],
} as const;

export const DEFAULT_POLICY = {
  cooldownMs: 30_000,
  breakerFailureThreshold: 3,
  breakerOpenMs: 5 * 60_000,
} as const;

function execFileAsync(cmd: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code ?? 1) : 1;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        return;
      }
      resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function fetchProbe(url: string, init?: { timeoutMs?: number; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; body?: string }> {
  const timeoutMs = init?.timeoutMs ?? 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: init?.method ?? "GET", signal: controller.signal, headers: init?.headers, body: init?.body });
    let body: string | undefined;
    try {
      body = await res.text();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** The live runtime: real shells, real HTTP. No printing, no secrets. */
export const liveRuntime: HealthRuntime = {
  now: () => Date.now(),
  run: (cmd, args, opts) => execFileAsync(cmd, args, opts?.timeoutMs ?? 30_000),
  fetch: fetchProbe,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Scan for orphaned provider CLI processes (PPID == 1) matching known executables. */
export async function scanStaleProviderProcesses(executables: readonly string[]): Promise<readonly { pid: number; executable: string }[]> {
  if (executables.length === 0) return [];
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm="], 5000);
  const out: { pid: number; executable: string }[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const comm = m[3]?.trim() ?? "";
    if (ppid === 1 && executables.includes(comm)) {
      out.push({ pid, executable: comm });
    }
  }
  return out;
}

/** Audit the session store dir: existence, writability, parse integrity. */
export async function auditSessionStore(baseDir: string): Promise<{ dir: string; writable: boolean; sessions: number; corrupt: string[]; exists: boolean }> {
  let exists = false;
  let writable = false;
  try {
    await fsPromises.access(baseDir, fsConstants.W_OK);
    writable = true;
    exists = true;
  } catch {
    try {
      await fsPromises.access(baseDir, fsConstants.F_OK);
      exists = true;
    } catch {
      exists = false;
    }
  }
  let sessions = 0;
  const corrupt: string[] = [];
  try {
    const entries = await fsPromises.readdir(baseDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      sessions += 1;
      try {
        JSON.parse(await fsPromises.readFile(join(baseDir, entry), "utf8"));
      } catch {
        corrupt.push(entry);
      }
    }
  } catch {
    // unreadable dir → sessions stays 0; exists/writable already reflect reality
  }
  return { dir: baseDir, writable, sessions, corrupt, exists };
}
