import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoMap, repoMapBlock, scanProject } from "../repo-map.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-map-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/launcher"), { recursive: true });
  writeFileSync(join(root, "src/auth/credential-manager.ts"), "export class CredentialManager {\n  setCredential() {}\n  getCredential() {}\n}\n");
  writeFileSync(join(root, "src/launcher/launcher.ts"), "import { CredentialManager } from '../auth/credential-manager';\nexport class Launcher {\n  prepareLaunch() {}\n  listAuthenticatedProviders() {}\n}\n");
  writeFileSync(join(root, "src/index.ts"), "export * from './auth/credential-manager';\nexport * from './launcher/launcher';\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
}

describe("scanProject", () => {
  it("extracts symbols and imports from source files", async () => {
    const root = fixture();
    const index = await scanProject(root, {});
    expect(index.files.length).toBe(3);
    const cm = index.files.find((f) => f.path.endsWith("credential-manager.ts"))!;
    expect(cm.symbols.map((s) => s.name)).toContain("CredentialManager");
    const launcher = index.files.find((f) => f.path.endsWith("launcher.ts"))!;
    expect(launcher.symbols.map((s) => s.name)).toContain("Launcher");
    expect(launcher.imports).toContain("../auth/credential-manager");
  });
});

describe("buildRepoMap", () => {
  it("builds a budgeted map and ranks query-relevant files first", async () => {
    const root = fixture();
    const result = await buildRepoMap(root, "credential auth manager", { budgetTokens: 400 });
    expect(result.built).toBe(true);
    expect(result.fileCount).toBe(3);
    expect(result.text).toContain("credential-manager.ts");
    // relevance: the auth file should appear before the launcher file
    expect(result.text.indexOf("credential-manager.ts")).toBeLessThan(result.text.indexOf("launcher.ts"));
  });

  it("degrades safely when the directory has no source files", async () => {
    const empty = mkdtempSync(join(tmpdir(), "repo-map-empty-"));
    const result = await buildRepoMap(empty, "anything", {});
    expect(result.built).toBe(false);
    expect(result.text).toBe("");
  });

  it("produces a project-context ContextBlock", async () => {
    const root = fixture();
    const result = await buildRepoMap(root, "launch", {});
    const block = repoMapBlock(result, "launch");
    expect(block).toBeDefined();
    expect(block!.class).toBe("project-context");
    expect(block!.id).toBe("repo-map");
    expect(block!.content).toContain("repo-map");
  });

  it("uses the cache on the second identical build", async () => {
    const root = fixture();
    const cache = new Map<string, string>();
    const c = { get: async (k: string) => cache.get(k), set: async (k: string, v: string) => { cache.set(k, v); } };
    const a = await buildRepoMap(root, "x", {}, c);
    const b = await buildRepoMap(root, "x", {}, c);
    expect(a.text).toBe(b.text);
    expect(cache.size).toBe(1); // only one scan happened (fingerprint unchanged)
  });
});
