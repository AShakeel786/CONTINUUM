import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteUserManifest,
  loadUserManifests,
  saveUserManifest,
} from "../manifest-store.js";
import { MANIFEST_SCHEMA_VERSION, type ProviderManifest } from "../manifest.js";

const grok: ProviderManifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  id: "grok",
  displayName: "Grok",
  protocol: "openai-compatible",
  baseUrl: "https://api.x.ai/v1",
  auth: { kind: "api-key", envVar: "XAI_API_KEY" },
  models: { default: "grok-3" },
};

describe("manifest-store", () => {
  it("save/load/delete round-trips a user manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-pstore-"));
    await saveUserManifest(grok, dir);
    const { manifests, errors } = await loadUserManifests(dir);
    expect(errors).toEqual([]);
    expect(manifests.map((m) => m.id)).toEqual(["grok"]);

    expect(await deleteUserManifest("grok", dir)).toBe(true);
    expect((await loadUserManifests(dir)).manifests).toEqual([]);
  });

  it("reports a validation error for an invalid manifest file and skips it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-pstore-"));
    const providersDir = join(dir, "providers");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(join(providersDir, "bad.json"), JSON.stringify({ schemaVersion: 99, id: "bad" }), "utf8");
    const { manifests, errors } = await loadUserManifests(dir);
    expect(manifests).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]!.file).toBe("bad.json");
  });

  it("loads nothing (not an error) when no providers dir exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-pstore-"));
    const { manifests, errors } = await loadUserManifests(dir);
    expect(manifests).toEqual([]);
    expect(errors).toEqual([]);
  });
});
