/**
 * Windows native credential backend — uses DPAPI
 * (`System.Security.Cryptography.ProtectedData`, `CurrentUser` scope) via a
 * short PowerShell helper. This is the same underlying mechanism Windows
 * Credential Manager itself is built on; encryption keys are managed
 * entirely by Windows and tied to the logged-in user's profile — no key
 * material is generated or stored by CONTINUUM.
 *
 * Secret values are always piped through stdin, never passed as a command-
 * line argument (which would land in process listings / shell history) —
 * the PowerShell script itself is a fixed, secret-free string.
 */

import { spawn } from "node:child_process";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { resolveDataDir } from "../../config/paths.js";
import type { CredentialBackend } from "../types.js";
import { assertNotUnderTest } from "./test-guard.js";

function runPowerShellPipe(script: string, stdinInput: string): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`powershell exited ${exitCode}: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout, exitCode });
    });
    child.stdin.write(stdinInput, "utf8");
    child.stdin.end();
  });
}

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$plaintext = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plaintext)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$b64 = [Console]::In.ReadToEnd()
$protected = [Convert]::FromBase64String($b64)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
`;

interface DpapiVaultFile {
  readonly entries: Readonly<Record<string, string>>; // key -> base64 DPAPI blob
}

export class WindowsDpapiCredentialBackend implements CredentialBackend {
  readonly id = "windows-dpapi";
  readonly securityLevel = "os-native" as const;
  readonly description =
    "Windows DPAPI (CurrentUser scope) — the same mechanism Windows Credential Manager is built on. " +
    "Encryption keys are managed by Windows and tied to your login; CONTINUUM never generates or stores a key.";

  private readonly filePath: string;

  constructor(dataDir?: string) {
    this.filePath = path.join(dataDir ?? resolveDataDir(), "dpapi-vault.json");
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      // Cheap round-trip proves DPAPI + PowerShell actually work in this environment,
      // not just that we're on win32.
      const probe = await this.protect("continuum-dpapi-probe");
      const result = await this.unprotect(probe);
      return result === "continuum-dpapi-probe";
    } catch {
      return false;
    }
  }

  private async protect(plaintext: string): Promise<string> {
    const { stdout } = await runPowerShellPipe(PROTECT_SCRIPT, plaintext);
    return stdout;
  }

  private async unprotect(base64Blob: string): Promise<string> {
    const { stdout } = await runPowerShellPipe(UNPROTECT_SCRIPT, base64Blob);
    return stdout;
  }

  private async loadVault(): Promise<DpapiVaultFile> {
    try {
      const raw = await fsPromises.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as DpapiVaultFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: {} };
      throw err;
    }
  }

  private async saveVault(vault: DpapiVaultFile): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsPromises.writeFile(this.filePath, JSON.stringify(vault, null, 2), "utf8");
  }

  async set(key: string, value: string): Promise<void> {
    assertNotUnderTest(this.id, "set");
    const blob = await this.protect(value);
    const vault = await this.loadVault();
    await this.saveVault({ entries: { ...vault.entries, [key]: blob } });
  }

  async get(key: string): Promise<string | undefined> {
    const vault = await this.loadVault();
    const blob = vault.entries[key];
    if (!blob) return undefined;
    return this.unprotect(blob);
  }

  async delete(key: string): Promise<void> {
    assertNotUnderTest(this.id, "delete");
    const vault = await this.loadVault();
    if (!(key in vault.entries)) return;
    const remaining = { ...vault.entries };
    delete remaining[key];
    await this.saveVault({ entries: remaining });
  }

  async list(): Promise<readonly string[]> {
    const vault = await this.loadVault();
    return Object.keys(vault.entries);
  }
}
