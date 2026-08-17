import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSessionStore } from "../../session/store.js";
import { SessionManager } from "../../session/manager.js";
import { buildProjectLabels, formatSessionPickerLine, formatSessionTime, listRecentSessions, UNKNOWN_PROJECT_LABEL } from "../session-list.js";
import type { RecentSessionSummary } from "../session-list.js";
import type { SessionMode, TaskSession } from "../../session/types.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cont-sess-list-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function makeSession(partial: Partial<TaskSession> = {}): TaskSession {
  return {
    schemaVersion: 1,
    sessionId: "s1",
    revision: 1,
    projectId: "p",
    workingDirectory: "/w",
    activeProvider: { providerId: "codex", model: "m" },
    taskGoal: "fix it",
    status: "active",
    completedWork: [],
    remainingWork: [],
    importantDecisions: [],
    relevantFiles: [],
    recentToolActivity: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as TaskSession;
}

/** A `RecentSessionSummary` fixture for `buildProjectLabels`/`formatSessionPickerLine` tests. */
function session(id: string, mode: SessionMode, overrides: Partial<RecentSessionSummary> = {}): RecentSessionSummary {
  return {
    sessionId: id,
    mode,
    workingDirectory: "/w",
    providerId: "codex",
    taskGoal: "fix it",
    status: "active",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatSessionTime", () => {
  // Build timestamps from the local calendar so assertions hold in any TZ.
  const now = new Date(2026, 7, 16, 20, 30, 0); // local Aug 16, 2026 8:30 PM
  it("shows only clock time for today", () => {
    const out = formatSessionTime(new Date(2026, 7, 16, 8, 21, 0).toISOString(), now);
    expect(out).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    expect(out).not.toContain("Aug");
  });

  it("shows month + day + clock for an older date", () => {
    const out = formatSessionTime(new Date(2026, 7, 15, 18, 13, 0).toISOString(), now);
    expect(out).toMatch(/^Aug 15, \d{1,2}:\d{2} [AP]M$/);
  });

  it("falls back to the raw value for an unparseable timestamp", () => {
    expect(formatSessionTime("not-a-date", now)).toBe("not-a-date");
  });

  it("returns unknown time for a missing timestamp", () => {
    expect(formatSessionTime(undefined, now)).toBe("unknown time");
  });
});

describe("formatSessionPickerLine", () => {
  const now = new Date("2026-08-16T20:30:00.000Z");
  const summary = {
    sessionId: "s1",
    projectId: "p",
    mode: "project" as const,
    workingDirectory: "/w",
    providerId: "deepseek",
    taskGoal: "NisfDeen RLS Batch 4 audit",
    status: "active",
    updatedAt: "2026-08-16T08:21:00.000Z",
  };

  it("marks the newest session with a star and a last-active line, project + provider bracketed", () => {
    const line = formatSessionPickerLine(summary, { isNewest: true, projectLabel: "PASSCARS", now, width: 80 });
    expect(line).toMatch(/^★ \[PASSCARS\] \[deepseek\] NisfDeen RLS Batch 4 audit\nLast active: \d{1,2}:\d{2} [AP]M$/);
  });

  it("uses a blank marker (no star) for non-newest sessions", () => {
    const line = formatSessionPickerLine(summary, { isNewest: false, projectLabel: "PASSCARS", now, width: 80 });
    expect(line.startsWith("  [PASSCARS] [deepseek]")).toBe(true);
    expect(line).not.toContain("★");
  });

  it("truncates a long goal to the available width", () => {
    const long = { ...summary, taskGoal: "x".repeat(200) };
    const line = formatSessionPickerLine(long, { isNewest: true, projectLabel: "PASSCARS", now, width: 60 });
    expect(line.split("\n")[0]!.length).toBeLessThanOrEqual(60);
    expect(line).toContain("…");
  });

  it("shows [Unknown project] when the caller resolves no label", () => {
    const line = formatSessionPickerLine(summary, { isNewest: true, projectLabel: "Unknown project", now, width: 80 });
    expect(line).toContain("[Unknown project] [deepseek]");
  });

  it("labels a general session's project bracket as [General]", () => {
    const general = { ...summary, mode: "general" as const, taskGoal: "(untitled)" };
    const line = formatSessionPickerLine(general, { isNewest: true, projectLabel: "General", now, width: 80 });
    expect(line).toContain("[General] [deepseek] (untitled)");
  });

  it("shows the working directory for a current-directory session", () => {
    const currentDir = { ...summary, mode: "current-directory" as const, workingDirectory: "/Users/home/some/repo" };
    const line = formatSessionPickerLine(currentDir, { isNewest: true, projectLabel: "Current directory", now, width: 80 });
    expect(line).toContain("[Current directory] [deepseek]");
    expect(line).toContain("/Users/home/some/repo");
  });
});

describe("buildProjectLabels", () => {
  it("resolves the registered project's canonical display name by id", async () => {
    const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
    const p = await registry.add({ name: "PASSCARS", path: tmp() });
    const labels = await buildProjectLabels([session("s1", "project", { projectId: p.id })], registry);
    expect(labels.get("s1")).toBe("PASSCARS");
  });

  it("shows [Unknown project] when the projectId no longer resolves (deleted project)", async () => {
    const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
    const labels = await buildProjectLabels([session("s1", "project", { projectId: "gone" })], registry);
    expect(labels.get("s1")).toBe(UNKNOWN_PROJECT_LABEL);
  });

  it("shows [Unknown project] for a legacy session with no projectId and an unmatched workingDirectory", async () => {
    const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
    await registry.add({ name: "PASSCARS", path: tmp() });
    const labels = await buildProjectLabels([session("s1", "project", { projectId: undefined, workingDirectory: "/nowhere" })], registry);
    expect(labels.get("s1")).toBe(UNKNOWN_PROJECT_LABEL);
  });

  it("resolves a legacy session with no projectId via a matching registered project path", async () => {
    const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
    const projectDir = tmp();
    await registry.add({ name: "PASSCARS", path: projectDir });
    const labels = await buildProjectLabels([session("s1", "project", { projectId: undefined, workingDirectory: projectDir })], registry);
    expect(labels.get("s1")).toBe("PASSCARS");
  });

  it("labels general and current-directory sessions without touching the registry's projectId lookup", async () => {
    const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
    const general = session("s1", "general", { projectId: undefined });
    const currentDir = session("s2", "current-directory", { projectId: undefined, workingDirectory: "/wherever" });
    const labels = await buildProjectLabels([general, currentDir], registry);
    expect(labels.get("s1")).toBe("General");
    expect(labels.get("s2")).toBe("Current directory");
  });

  it("reflects a project rename immediately — the name is resolved live, never persisted on the session", async () => {
    const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
    const p = await registry.add({ name: "OldName", path: tmp() });
    await registry.update(p.id, { name: "NewName" });
    const labels = await buildProjectLabels([session("s1", "project", { projectId: p.id })], registry);
    expect(labels.get("s1")).toBe("NewName");
  });

  it("distinguishes two sessions with the same provider/goal by their different projects", async () => {
    const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
    const a = await registry.add({ name: "PASSCARS", path: tmp() });
    const b = await registry.add({ name: "CONTINUUM", path: tmp() });
    const labels = await buildProjectLabels(
      [
        session("s1", "project", { projectId: a.id, providerId: "codex", taskGoal: "inspect src/session" }),
        session("s2", "project", { projectId: b.id, providerId: "codex", taskGoal: "inspect src/session" }),
      ],
      registry,
    );
    expect(labels.get("s1")).toBe("PASSCARS");
    expect(labels.get("s2")).toBe("CONTINUUM");
  });
});

describe("listRecentSessions", () => {
  it("sorts newest-active first, not creation order", async () => {
    const store = new FileSessionStore(tmp());
    const manager = new SessionManager(store);
    await store.save(makeSession({ sessionId: "a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z" }));
    await store.save(makeSession({ sessionId: "b", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z" }));
    await store.save(makeSession({ sessionId: "c", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }));

    const recent = await listRecentSessions(manager, 10);
    expect(recent.map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("falls back to createdAt for a legacy session missing updatedAt", async () => {
    const store = new FileSessionStore(tmp());
    const manager = new SessionManager(store);
    // `updatedAt: undefined` is dropped by JSON serialization, reproducing a legacy file.
    await store.save(makeSession({ sessionId: "legacy", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: undefined }));

    const recent = await listRecentSessions(manager, 10);
    expect(recent[0]!.updatedAt).toBe("2026-08-10T00:00:00.000Z");
  });

  it("falls back to file mtime for a legacy session missing both timestamps", async () => {
    const store = new FileSessionStore(tmp());
    const manager = new SessionManager(store);
    await store.save(makeSession({ sessionId: "ancient", createdAt: undefined, updatedAt: undefined }));

    const recent = await listRecentSessions(manager, 10);
    expect(Number.isNaN(new Date(recent[0]!.updatedAt).getTime())).toBe(false);
    expect(recent[0]!.updatedAt).not.toBe("1970-01-01T00:00:00.000Z");
  });

  it("defaults a legacy session (predating `mode`) to mode='project' and surfaces it in the summary", async () => {
    const store = new FileSessionStore(tmp());
    const manager = new SessionManager(store);
    // makeSession's fixture never sets `mode` — reproduces an on-disk file
    // written before the field existed.
    await store.save(makeSession({ sessionId: "legacy-mode" }));

    const recent = await listRecentSessions(manager, 10);
    expect(recent[0]!.mode).toBe("project");
    expect(recent[0]!.projectId).toBe("p");
  });

  it("round-trips a general session's mode and workingDirectory with no projectId", async () => {
    const store = new FileSessionStore(tmp());
    const manager = new SessionManager(store);
    await manager.createSession({
      sessionId: "gen-1",
      mode: "general",
      workingDirectory: "/wherever",
      activeProvider: { providerId: "claude", model: "m" },
      taskGoal: "explore",
    });

    const recent = await listRecentSessions(manager, 10);
    expect(recent[0]!.mode).toBe("general");
    expect(recent[0]!.workingDirectory).toBe("/wherever");
    expect(recent[0]!.projectId).toBeUndefined();
  });
});
