import { describe, expect, it } from "vitest";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateProvider, findExecutableOnPath } from "../usability.js";
import { manifestToAuthMetadata, manifestToProfile, type ProviderManifest } from "../../providers/manifest.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { antigravityManifest } from "../../providers/presets.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { antigravityAuthMetadata } from "../../auth/provider-auth/antigravity.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "in-memory test backend";
  private readonly store = new Map<string, string>();
  async isAvailable(): Promise<boolean> { return true; }
  async set(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async get(key: string): Promise<string | undefined> { return this.store.get(key); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async list(): Promise<readonly string[]> { return [...this.store.keys()]; }
}

function makeCliManager(installed: boolean, authenticated: boolean): CliAuthManager {
  const m = new CliAuthManager();
  const adapter: CliAuthAdapter = {
    providerId: "antigravity",
    capability: antigravityAuthMetadata.cli as never,
    async detectInstalled() { return installed ? "installed" : "not-installed"; },
    async detectAuthenticated() { return authenticated ? "authenticated" : "not-authenticated"; },
    async login() { return { completed: true, exitCode: 0 }; },
    async logout() { return undefined; },
  };
  m.register(adapter);
  return m;
}

describe("antigravity usability", () => {
  it("is CLI-launchable when installed + authenticated (cli-session, no key required)", async () => {
    const adapter = createProviderAdapter(manifestToProfile(antigravityManifest));
    const metadata = manifestToAuthMetadata(antigravityManifest);
    const e = await evaluateProvider(adapter, metadata, {
      cliAuthManager: makeCliManager(true, true),
      credentialManager: new CredentialManager(new FakeBackend()),
    });
    expect(e.usable).toBe(true);
    expect(e.launchKind).toBe("cli");
    expect(e.cliInstalled).toBe(true);
    expect(e.cliAuthenticated).toBe(true);
  });

  it("is not launchable when the CLI is authenticated but not installed", async () => {
    const adapter = createProviderAdapter(manifestToProfile(antigravityManifest));
    const metadata = manifestToAuthMetadata(antigravityManifest);
    const e = await evaluateProvider(adapter, metadata, {
      cliAuthManager: makeCliManager(false, true),
      credentialManager: new CredentialManager(new FakeBackend()),
    });
    expect(e.usable).toBe(false);
    expect(e.cliInstalled).toBe(false);
    expect(e.reason).toContain("not installed");
  });

  it("is not launchable when installed but not authenticated", async () => {
    const adapter = createProviderAdapter(manifestToProfile(antigravityManifest));
    const metadata = manifestToAuthMetadata(antigravityManifest);
    const e = await evaluateProvider(adapter, metadata, {
      cliAuthManager: makeCliManager(true, false),
      credentialManager: new CredentialManager(new FakeBackend()),
    });
    expect(e.usable).toBe(false);
    expect(e.cliAuthenticated).toBe(false);
  });
});

describe("findExecutableOnPath — home bin fallback", () => {
  it("still finds an executable in ~/.local/bin when PATH omits it (desktop launcher)", () => {
    const homeBinAgy = join(homedir(), ".local", "bin", "agy");
    let exists = false;
    try {
      accessSync(homeBinAgy, fsConstants.X_OK);
      exists = true;
    } catch {
      // no agy on this machine — nothing to verify
    }
    if (!exists) return;

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin"; // deliberately omit ~/.local/bin
      expect(findExecutableOnPath("agy")).toBe(homeBinAgy);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
