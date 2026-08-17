import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSessionStore } from "../../session/store.js";
import { SessionManager } from "../../session/manager.js";
import { formatSessionPickerLine, formatSessionTime, listRecentSessions } from "../session-list.js";
import type { TaskSession } from "../../session/types.js";

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
    providerId: "deepseek",
    taskGoal: "NisfDeen RLS Batch 4 audit",
    status: "active",
    updatedAt: "2026-08-16T08:21:00.000Z",
  };

  it("marks the newest session with a star and a last-active line", () => {
    const line = formatSessionPickerLine(summary, { isNewest: true, now, width: 80 });
    expect(line).toMatch(/^★ \[deepseek\] NisfDeen RLS Batch 4 audit\nLast active: \d{1,2}:\d{2} [AP]M$/);
  });

  it("uses a blank marker (no star) for non-newest sessions", () => {
    const line = formatSessionPickerLine(summary, { isNewest: false, now, width: 80 });
    expect(line.startsWith("  [deepseek]")).toBe(true);
    expect(line).not.toContain("★");
  });

  it("truncates a long goal to the available width", () => {
    const long = { ...summary, taskGoal: "x".repeat(200) };
    const line = formatSessionPickerLine(long, { isNewest: true, now, width: 60 });
    expect(line.split("\n")[0]!.length).toBeLessThanOrEqual(60);
    expect(line).toContain("…");
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
});
