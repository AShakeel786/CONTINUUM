import { afterEach, describe, expect, it } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSessionStore } from "../store.js";
import { SessionConflictError, SessionCorruptionError, SessionNotFoundError, UnsupportedSchemaVersionError } from "../errors.js";
import { SESSION_SCHEMA_VERSION, type TaskSession } from "../types.js";

let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "continuum-session-store-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fsPromises.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

function fixtureSession(overrides: Partial<TaskSession> = {}): TaskSession {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: "sess-1",
    revision: 1,
    projectId: "proj-1",
    mode: "project",
    workingDirectory: "C:\\fake\\project",
    activeProvider: { providerId: "claude", model: "claude-sonnet-5" },
    taskGoal: "Fix the bug",
    status: "active",
    completedWork: [],
    remainingWork: [],
    importantDecisions: [],
    relevantFiles: [],
    recentToolActivity: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FileSessionStore — save/load", () => {
  it("saves and loads a session with identical content", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    const session = fixtureSession();
    await store.save(session);
    const loaded = await store.load("sess-1");
    expect(loaded).toEqual(session);
  });

  it("throws SessionNotFoundError for a session that was never created", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await expect(store.load("nope")).rejects.toThrow(SessionNotFoundError);
  });

  it("exists() correctly reports presence/absence", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    expect(await store.exists("sess-1")).toBe(false);
    await store.save(fixtureSession());
    expect(await store.exists("sess-1")).toBe(true);
  });

  it("survives a simulated process restart -- a fresh FileSessionStore instance on the same directory sees prior saves", async () => {
    const dir = await makeTmpDir();
    const storeA = new FileSessionStore(dir);
    await storeA.save(fixtureSession({ taskGoal: "Original goal" }));

    // Simulate a new process: a brand-new store instance, no shared in-memory state.
    const storeB = new FileSessionStore(dir);
    const loaded = await storeB.load("sess-1");
    expect(loaded.taskGoal).toBe("Original goal");
  });

  it("rejects a write with a stale expectedRevision (SessionConflictError) rather than overwriting newer work", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await store.save(fixtureSession({ revision: 1 }));
    // Someone else advances it to revision 2.
    await store.save(fixtureSession({ revision: 2, taskGoal: "Updated by someone else" }), { expectedRevision: 1 });

    // Now a stale writer, still holding revision 1, tries to save.
    await expect(
      store.save(fixtureSession({ revision: 2, taskGoal: "Stale writer's conflicting update" }), { expectedRevision: 1 }),
    ).rejects.toThrow(SessionConflictError);

    // The winning write is what's actually on disk.
    const loaded = await store.load("sess-1");
    expect(loaded.taskGoal).toBe("Updated by someone else");
  });

  it("allows a write with the correct expectedRevision", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await store.save(fixtureSession({ revision: 1 }));
    await expect(
      store.save(fixtureSession({ revision: 2, taskGoal: "Correctly sequenced update" }), { expectedRevision: 1 }),
    ).resolves.not.toThrow();
  });

  it("throws SessionCorruptionError when the stored file is corrupted with no usable backup", async () => {
    const dir = await makeTmpDir();
    await fsPromises.writeFile(path.join(dir, "sess-1.json"), "not json", "utf8");
    const store = new FileSessionStore(dir);
    await expect(store.load("sess-1")).rejects.toThrow(SessionCorruptionError);
  });

  it("recovers from .bak when the primary is corrupted", async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    await store.save(fixtureSession({ taskGoal: "v1" }));
    await store.save(fixtureSession({ taskGoal: "v2", revision: 2 }), { expectedRevision: 1 });
    // Corrupt the primary in place.
    await fsPromises.writeFile(path.join(dir, "sess-1.json"), "corrupted", "utf8");
    const loaded = await store.load("sess-1");
    expect(loaded.taskGoal).toBe("v1"); // recovered from .bak, the previous version
  });

  it("refuses to load a session whose schemaVersion is newer than this build supports", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await store.save(fixtureSession({ schemaVersion: SESSION_SCHEMA_VERSION + 1 }));
    await expect(store.load("sess-1")).rejects.toThrow(UnsupportedSchemaVersionError);
  });

  it("backfills mode='project' on load for a session file written before `mode` existed", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    const legacy = fixtureSession() as unknown as Record<string, unknown>;
    delete legacy.mode; // simulate an on-disk file predating the `mode` field
    await store.save(legacy as unknown as TaskSession);
    const loaded = await store.load("sess-1");
    expect(loaded.mode).toBe("project");
    expect(loaded.projectId).toBe("proj-1");
  });

  it("listSessionIds returns an empty array for a directory that doesn't exist yet, not an error", async () => {
    const dir = path.join(os.tmpdir(), "continuum-never-created-" + Math.random().toString(36).slice(2));
    const store = new FileSessionStore(dir);
    expect(await store.listSessionIds()).toEqual([]);
  });

  it("listSessionIds lists saved sessions by id", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await store.save(fixtureSession({ sessionId: "sess-a" }));
    await store.save(fixtureSession({ sessionId: "sess-b" }));
    expect((await store.listSessionIds()).sort()).toEqual(["sess-a", "sess-b"]);
  });

  it("delete() removes a session and it can no longer be loaded", async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await store.save(fixtureSession());
    await store.delete("sess-1");
    await expect(store.load("sess-1")).rejects.toThrow(SessionNotFoundError);
  });

  it("no secret-shaped values are ever persisted in the stored file", async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    await store.save(fixtureSession());
    const raw = await fsPromises.readFile(path.join(dir, "sess-1.json"), "utf8");
    expect(raw).not.toMatch(/sk-[a-zA-Z0-9_-]{8,}/);
    expect(raw).not.toMatch(/-----BEGIN/);
  });
});
