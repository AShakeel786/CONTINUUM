import { afterEach, describe, expect, it } from "vitest";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { atomicWriteJson, fileExists, readJsonWithRecovery } from "../atomic-file.js";
import { SessionCorruptionError } from "../errors.js";

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "continuum-atomic-file-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fsPromises.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

describe("atomicWriteJson / readJsonWithRecovery", () => {
  it("writes and reads back identical data", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "session.json");
    await atomicWriteJson(file, { hello: "world", n: 42 });
    const result = await readJsonWithRecovery<{ hello: string; n: number }>(file);
    expect(result.data).toEqual({ hello: "world", n: 42 });
    expect(result.recoveredFromBackup).toBe(false);
  });

  it("creates the parent directory if it doesn't exist", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "nested", "deeper", "session.json");
    await atomicWriteJson(file, { ok: true });
    expect(await fileExists(file)).toBe(true);
  });

  it("leaves no temp files behind after a successful write", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "session.json");
    await atomicWriteJson(file, { v: 1 });
    const entries = await fsPromises.readdir(dir);
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
  });

  it("keeps a .bak of the previous version after a second write", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "session.json");
    await atomicWriteJson(file, { v: 1 });
    await atomicWriteJson(file, { v: 2 });
    expect(await fileExists(`${file}.bak`)).toBe(true);
    const backup = await readJsonWithRecovery<{ v: number }>(`${file}.bak`);
    expect(backup.data.v).toBe(1);
    const current = await readJsonWithRecovery<{ v: number }>(file);
    expect(current.data.v).toBe(2);
  });

  it("detects a corrupted primary file and recovers from .bak", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "session.json");
    await atomicWriteJson(file, { v: 1 }); // v1 becomes the eventual .bak
    await atomicWriteJson(file, { v: 2 }); // v2 is primary, v1 is now .bak

    // Corrupt the primary in place (simulate e.g. a crash mid-write on a
    // filesystem without our atomic rename guarantee, or disk corruption).
    await fsPromises.writeFile(file, '{"checksum":"deadbeef","data":{"v":2}}', "utf8");

    const result = await readJsonWithRecovery<{ v: number }>(file);
    expect(result.recoveredFromBackup).toBe(true);
    expect(result.data.v).toBe(1);
  });

  it("throws SessionCorruptionError when both primary and .bak are corrupt", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "session.json");
    await fsPromises.writeFile(file, "not even json", "utf8");
    await fsPromises.writeFile(`${file}.bak`, "also not json", "utf8");

    await expect(readJsonWithRecovery(file)).rejects.toThrow(SessionCorruptionError);
  });

  it("throws SessionCorruptionError when only the primary exists and is corrupt (no .bak to fall back to)", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "session.json");
    await fsPromises.writeFile(file, "not json at all", "utf8");
    await expect(readJsonWithRecovery(file)).rejects.toThrow(SessionCorruptionError);
  });

  it("fileExists correctly reports absence", async () => {
    const dir = await makeTmpDir();
    expect(await fileExists(path.join(dir, "nope.json"))).toBe(false);
  });
});
