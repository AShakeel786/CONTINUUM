import { describe, expect, it } from "vitest";
import { runInteractiveMenu } from "../interactive.js";
import { createScriptedPrompt } from "../../../auth/prompt.js";
import type { ProjectRecord } from "../../../registry/types.js";
import type { ProviderUsability } from "../../../launcher/launcher.js";
import type { RecentSessionSummary } from "../../../launcher/session-list.js";

function project(id: string, name: string): ProjectRecord {
  return { id, name, path: `/work/${name}`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function provider(id: string, displayName: string, usable: boolean, reason?: string): ProviderUsability {
  return { providerId: id, displayName, model: `${id}-model`, usable, reason };
}

function session(id: string, projectId: string, providerId: string, goal: string): RecentSessionSummary {
  return { sessionId: id, projectId, providerId, taskGoal: goal, status: "active", updatedAt: "2026-01-02T00:00:00.000Z" };
}

function capture(): { out: (s: string) => void; text: () => string } {
  let buf = "";
  return { out: (s: string) => { buf += s; }, text: () => buf };
}

describe("runInteractiveMenu", () => {
  it("prints the CONTINUUM header exactly once", async () => {
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: [project("p1", "Alpha")], providers: [], sessions: [] },
      createScriptedPrompt({ answers: ["0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect((cap.text().match(/CONTINUUM/g) ?? []).length).toBe(1);
  });

  it("exits with guidance when no projects are registered", async () => {
    const cap = capture();
    const decision = await runInteractiveMenu({ projects: [], providers: [], sessions: [] }, createScriptedPrompt({ answers: [] }), cap.out);
    expect(decision.kind).toBe("exit");
    expect(cap.text()).toContain("No projects registered");
  });

  it("start-new flow: project → action → provider → goal", async () => {
    const cap = capture();
    const decision = await runInteractiveMenu(
      {
        projects: [project("p1", "Alpha"), project("p2", "Beta")],
        providers: [provider("codex", "Codex", true), provider("deepseek", "DeepSeek", true)],
        sessions: [],
      },
      createScriptedPrompt({ answers: ["1", "1", "2", "ship it"] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "new", projectId: "p1", providerId: "deepseek", taskGoal: "ship it" });
    expect((cap.text().match(/CONTINUUM/g) ?? []).length).toBe(1);
  });

  it("offers only usable providers and surfaces a disabled reason", async () => {
    const cap = capture();
    const decision = await runInteractiveMenu(
      {
        projects: [project("p1", "Alpha")],
        providers: [provider("codex", "Codex", true), provider("deepseek", "DeepSeek", false, "no proxy user key")],
        sessions: [],
      },
      createScriptedPrompt({ answers: ["1", "1", "1", ""] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "new", projectId: "p1", providerId: "codex", taskGoal: "" });
    const text = cap.text();
    expect(text).toContain("1. Codex");
    expect(text).not.toContain("2. DeepSeek");
    expect(text).toContain("DeepSeek unavailable: no proxy user key");
  });

  it("resume flow: project → action → session (scoped to project)", async () => {
    const cap = capture();
    const decision = await runInteractiveMenu(
      {
        projects: [project("p1", "Alpha")],
        providers: [],
        sessions: [session("s1", "p1", "codex", "fix the bug"), session("s2", "p1", "deepseek", "write tests")],
      },
      createScriptedPrompt({ answers: ["1", "2", "1"] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "resume", sessionId: "s1" });
  });

  it("exits cleanly on a zero/quit selection", async () => {
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: [project("p1", "Alpha")], providers: [], sessions: [] },
      createScriptedPrompt({ answers: ["q"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
  });
});
