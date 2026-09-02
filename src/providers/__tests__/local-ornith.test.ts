import { describe, expect, it } from "vitest";
import { localOrnith15Manifest } from "../presets.js";
import { manifestToProfile, validateManifest } from "../manifest.js";
import { createDefaultProviderRegistry, createProviderRegistry } from "../index.js";
import { DEFAULT_PROVIDER_PREFERENCE_CHAIN } from "../presets.js";
import { createProviderAdapter } from "../adapter.js";

describe("local-ornith15 bundled provider", () => {
  it("is a valid manifest", () => {
    expect(validateManifest(localOrnith15Manifest)).toEqual([]);
  });

  it("rejects a localService block with a newline-injected command or args (no shell-string execution)", () => {
    const bad = {
      ...localOrnith15Manifest,
      id: "local-bad",
      idAliases: undefined,
      localService: { command: "python\nrm -rf /", args: ["--model\n--host", 42] as unknown as string[] },
    };
    const errs = validateManifest(bad);
    expect(errs.some((e) => e.includes("localService.command"))).toBe(true);
    expect(errs.some((e) => e.includes("localService.args"))).toBe(true);
  });

  it("rejects an out-of-range localService.port", () => {
    const bad = { ...localOrnith15Manifest, id: "local-bad2", idAliases: undefined, localService: { command: "s", args: [], port: 99999 } };
    expect(validateManifest(bad).some((e) => e.includes("localService.port"))).toBe(true);
  });

  it("resolves the exact Ornith model / venv / server wiring", () => {
    expect(localOrnith15Manifest.id).toBe("local-ornith15");
    expect(localOrnith15Manifest.displayName).toBe("Local Ornith 1.5 35B A3B");
    expect(localOrnith15Manifest.protocol).toBe("openai-compatible");
    expect(localOrnith15Manifest.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(localOrnith15Manifest.models.default).toBe(
      "/Users/home/Models/Coding/Ornith-1.5-35B-A3B-REAP192-mxfp4-MLX",
    );
    expect(localOrnith15Manifest.localService).toMatchObject({
      command: "/Users/home/.venvs/ornith15/bin/python",
      args: ["-m", "mlx_lm", "server", "--model", "${model}", "--host", "${host}", "--port", "${port}"],
      port: 8080,
    });
  });

  it("needs no credential (auth: none) and is direct-API only", () => {
    const profile = manifestToProfile(localOrnith15Manifest);
    expect(profile.auth.kind).toBe("none");
    expect(profile.capabilities.cliAvailable).toBe(false);
    // A no-auth provider builds no Authorization header — and never throws.
    const adapter = createProviderAdapter(profile);
    expect(adapter.buildAuthHeaders()).toEqual({});
  });

  it("keeps the retired local-qwen38 id resolving to the managed Ornith provider", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.has("local-qwen38")).toBe(true);
    expect(registry.get("local-qwen38").profile.id).toBe("local-ornith15");
    expect(registry.canonicalId("local-qwen38")).toBe("local-ornith15");
    // The alias is not listed as a canonical id.
    expect(registry.listIds()).not.toContain("local-qwen38");
  });

  it("is NOT in the automatic free-provider preference chain (local, never auto-picked)", () => {
    expect(DEFAULT_PROVIDER_PREFERENCE_CHAIN).not.toContain("local-ornith15");
    expect(localOrnith15Manifest.freeOnlyEligible).toBe(false);
  });

  it("is secret-free as serialized data", () => {
    const json = JSON.stringify(manifestToProfile(localOrnith15Manifest));
    expect(json).not.toMatch(/sk-[a-zA-Z0-9_-]{8,}|AKID[a-zA-Z0-9]{8,}|-----BEGIN/);
  });
});

describe("stale user manifest is shadowed by a bundled preset that reserves its id/alias", () => {
  it("skips a user manifest whose id collides with a bundled id-alias", () => {
    const staleQwen = {
      schemaVersion: 1 as const,
      id: "local-qwen38",
      displayName: "Local Qwen3.8 27B",
      protocol: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:8080/v1",
      auth: { kind: "api-key" as const, envVar: "LOCAL_QWEN38_API_KEY" },
      models: { default: "/Users/home/Models/Coding/Qwen3.8-27B-4bit" },
    };
    const registry = createProviderRegistry([staleQwen]);
    // The bundled Ornith wins; the stale Qwen model path is not reachable.
    expect(registry.get("local-qwen38").profile.id).toBe("local-ornith15");
    expect(registry.get("local-qwen38").profile.models.default).toContain("Ornith");
  });
});
