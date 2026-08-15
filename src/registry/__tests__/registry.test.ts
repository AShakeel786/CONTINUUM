import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, normalizeProjectPath } from "../registry.js";
import { ProjectRegistryStore } from "../store.js";
import { ProjectAlreadyExistsError, ProjectNotFoundError } from "../errors.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "continuum-registry-"));
}

function reg(dataDir: string): ProjectRegistry {
  return new ProjectRegistry(new ProjectRegistryStore(dataDir));
}

describe("ProjectRegistry CRUD", () => {
  it("adds, resolves by name/alias/id, and lists", async () => {
    const r = reg(tmpDir());
    const p = await r.add({ name: "CARS", path: "/work/CARS", aliases: ["cars"] });
    expect(p.id).toBeTruthy();
    expect((await r.resolve("CARS")).id).toBe(p.id);
    expect((await r.resolve("cars")).id).toBe(p.id);
    expect((await r.resolve(p.id)).id).toBe(p.id);
    expect(await r.list()).toHaveLength(1);
  });

  it("rejects duplicate name, alias, and path", async () => {
    const r = reg(tmpDir());
    await r.add({ name: "CARS", path: "/work/CARS", aliases: ["cars"] });
    await expect(r.add({ name: "cars", path: "/work/other" })).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
    await expect(r.add({ name: "other", path: "/work/CARS" })).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
    await expect(r.add({ name: "other", path: "/work/x", aliases: ["CARS"] })).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
  });

  it("throws ProjectNotFoundError for unknown keys", async () => {
    const r = reg(tmpDir());
    await expect(r.resolve("nope")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("updates fields and enforces cross-project uniqueness", async () => {
    const r = reg(tmpDir());
    const a = await r.add({ name: "A", path: "/a" });
    await r.add({ name: "B", path: "/b" });
    const upd = await r.update(a.id, { name: "A2", defaultProvider: "claude", aliases: ["a2"] });
    expect(upd.name).toBe("A2");
    expect(upd.defaultProvider).toBe("claude");
    expect(upd.aliases).toEqual(["a2"]);
    await expect(r.update(a.id, { name: "B" })).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
  });

  it("removes a project", async () => {
    const r = reg(tmpDir());
    const p = await r.add({ name: "X", path: "/x" });
    await r.remove(p.id);
    expect(await r.list()).toHaveLength(0);
  });
});

describe("CWD detection", () => {
  it("detects exact and ancestor matches, returns undefined otherwise", async () => {
    const r = reg(tmpDir());
    await r.add({ name: "root", path: "/work/root" });
    await r.add({ name: "nested", path: "/work/root/apps/nested" });
    expect((await r.detect("/work/root"))?.name).toBe("root");
    expect((await r.detect("/work/root/src/deep/dir"))?.name).toBe("root");
    expect((await r.detect("/work/root/apps/nested"))?.name).toBe("nested");
    expect(await r.detect("/elsewhere")).toBeUndefined();
  });

  it("does not match a sibling with a shared prefix", async () => {
    const r = reg(tmpDir());
    await r.add({ name: "foo", path: "/work/foo" });
    expect(await r.detect("/work/foobar")).toBeUndefined();
  });
});

describe("normalizeProjectPath", () => {
  it("expands ~ and resolves", () => {
    const withHome = normalizeProjectPath("~/work");
    expect(withHome).toBe(join(process.env.HOME ?? "", "work"));
    expect(normalizeProjectPath("relative/path")).toBe(join(process.cwd(), "relative/path"));
  });
});

describe("validateProvider", () => {
  it("rejects unknown default providers", () => {
    const r = reg(tmpDir());
    expect(() => r.validateProvider("gemini", new Set(["claude", "deepseek"]))).toThrow();
    expect(() => r.validateProvider("claude", new Set(["claude", "deepseek"]))).not.toThrow();
    expect(() => r.validateProvider(undefined, new Set())).not.toThrow();
  });
});
