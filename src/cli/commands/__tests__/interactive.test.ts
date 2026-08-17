import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInteractiveMenu } from "../interactive.js";
import { createScriptedPrompt } from "../../../auth/prompt.js";
import { ProjectRegistry } from "../../../registry/registry.js";
import { ProjectRegistryStore } from "../../../registry/store.js";
import { normalizeProjectPath } from "../../../registry/registry.js";
import type { ProviderUsability } from "../../../launcher/launcher.js";
import type { RecentSessionSummary } from "../../../launcher/session-list.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cont-int-"));
}

function provider(id: string, displayName: string, usable: boolean, reason?: string): ProviderUsability {
  return { providerId: id, displayName, model: `${id}-model`, usable, reason };
}

function session(id: string, projectId: string, providerId: string, goal: string, updatedAt = "2026-01-02T00:00:00.000Z"): RecentSessionSummary {
  return { sessionId: id, projectId, providerId, taskGoal: goal, status: "active", updatedAt };
}

function capture(): { out: (s: string) => void; text: () => string } {
  let buf = "";
  return { out: (s: string) => { buf += s; }, text: () => buf };
}

async function makeRegistry(seed?: { name: string; path: string }[]): Promise<ProjectRegistry> {
  const registry = new ProjectRegistry(new ProjectRegistryStore(tmp()));
  for (const s of seed ?? []) await registry.add({ name: s.name, path: s.path });
  return registry;
}

const KNOWN = new Set(["codex", "deepseek"]);

describe("runInteractiveMenu — project management", () => {
  it("adds a valid project, then returns to the menu (immediately launchable)", async () => {
    const registry = await makeRegistry();
    const cwd = tmp();
    const projPath = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [provider("codex", "Codex", true)], sessions: [], knownProviders: KNOWN, cwd },
      createScriptedPrompt({ answers: ["1", "myproj", projPath, "", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    const list = await registry.list();
    expect(list.map((p) => p.name)).toEqual(["myproj"]);
    expect(list[0]!.path).toBe(normalizeProjectPath(projPath));
    expect(cap.text()).toContain('✓ Added project "myproj"');
  });

  it("rejects a non-existent path", async () => {
    const registry = await makeRegistry();
    const cwd = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd },
      createScriptedPrompt({ answers: ["1", "myproj", "/definitely/not/a/real/dir", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect(await registry.list()).toHaveLength(0);
    expect(cap.text()).toContain("does not exist");
  });

  it("rejects a duplicate project name", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cwd = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd },
      createScriptedPrompt({ answers: ["2", "Alpha", tmp(), "", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect(await registry.list()).toHaveLength(1);
    expect(cap.text()).toContain("Cannot add project");
  });

  it("adds a project and immediately launches it (start new)", async () => {
    const registry = await makeRegistry();
    const cwd = tmp();
    const projPath = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [provider("codex", "Codex", true)], sessions: [], knownProviders: KNOWN, cwd },
      createScriptedPrompt({ answers: ["1", "myproj", projPath, "", "1", "1", "1", "do it"] }),
      cap.out,
    );
    const added = (await registry.list()).find((p) => p.name === "myproj")!;
    expect(decision).toEqual({ kind: "new", projectId: added.id, providerId: "codex", taskGoal: "do it" });
  });

  it("removes a project via manage", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cwd = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd },
      createScriptedPrompt({ answers: ["3", "2", "1", "0", "0"], confirms: [true] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect(await registry.list()).toHaveLength(0);
    expect(cap.text()).toContain('✓ Removed "Alpha"');
  });

  it("sets a project's default provider via manage", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cwd = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd },
      createScriptedPrompt({ answers: ["3", "4", "1", "deepseek", "0", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    const list = await registry.list();
    expect(list[0]!.defaultProvider).toBe("deepseek");
    expect(cap.text()).toContain('Default provider for "Alpha" set to deepseek');
  });

  it("offers to register the current directory when unregistered", async () => {
    const registry = await makeRegistry();
    const cwd = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd },
      createScriptedPrompt({ answers: ["3", "cwdproj", "", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect(cap.text()).toContain("Register current directory");
    const list = await registry.list();
    expect(list.map((p) => p.name)).toEqual(["cwdproj"]);
    expect(list[0]!.path).toBe(normalizeProjectPath(cwd));
  });

  it("does not offer current-directory registration when already inside a project", async () => {
    const projDir = tmp();
    const registry = await makeRegistry([{ name: "Alpha", path: projDir }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd: projDir },
      createScriptedPrompt({ answers: ["0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect(cap.text()).not.toContain("Register current directory");
  });
});

describe("runInteractiveMenu — regression (start/resume/provider/exit)", () => {
  it("prints the CONTINUUM header exactly once", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd: tmp() },
      createScriptedPrompt({ answers: ["0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect((cap.text().match(/CONTINUUM/g) ?? []).length).toBe(1);
  });

  it("start-new flow: project → action → provider → goal", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }, { name: "Beta", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      {
        projects: registry,
        providers: [provider("codex", "Codex", true), provider("deepseek", "DeepSeek", true)],
        sessions: [],
        knownProviders: KNOWN,
        cwd: tmp(),
      },
      createScriptedPrompt({ answers: ["1", "1", "2", "ship it"] }),
      cap.out,
    );
    const alpha = (await registry.list()).find((p) => p.name === "Alpha")!;
    expect(decision).toEqual({ kind: "new", projectId: alpha.id, providerId: "deepseek", taskGoal: "ship it" });
  });

  it("offers only usable providers and surfaces a disabled reason", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      {
        projects: registry,
        providers: [provider("codex", "Codex", true), provider("deepseek", "DeepSeek", false, "no proxy user key")],
        sessions: [],
        knownProviders: KNOWN,
        cwd: tmp(),
      },
      createScriptedPrompt({ answers: ["1", "1", "1", ""] }),
      cap.out,
    );
    expect(decision.kind).toBe("new");
    const text = cap.text();
    expect(text).toContain("1. Codex");
    expect(text).not.toContain("2. DeepSeek");
    expect(text).toContain("DeepSeek unavailable: no proxy user key");
  });

  it("resume flow: project → action → session (scoped to project)", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const alpha = (await registry.list())[0]!;
    const cap = capture();
    const decision = await runInteractiveMenu(
      {
        projects: registry,
        providers: [],
        sessions: [session("s1", alpha.id, "codex", "fix the bug"), session("s2", alpha.id, "deepseek", "write tests")],
        knownProviders: KNOWN,
        cwd: tmp(),
      },
      createScriptedPrompt({ answers: ["1", "2", "1"] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "resume", sessionId: "s1" });
  });

  it("resume flow sorts newest-active first, marks it with ★, and still resumes the selected session", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const alpha = (await registry.list())[0]!;
    const cap = capture();
    const decision = await runInteractiveMenu(
      {
        projects: registry,
        providers: [],
        sessions: [
          session("older", alpha.id, "codex", "older work", "2026-01-01T00:00:00.000Z"),
          session("newest", alpha.id, "deepseek", "newest work", "2026-01-03T00:00:00.000Z"),
        ],
        knownProviders: KNOWN,
        cwd: tmp(),
      },
      createScriptedPrompt({ answers: ["1", "2", "2"] }), // select the 2nd listed (older) to prove ordering changed
      cap.out,
    );
    const text = cap.text();
    expect(text).toContain("1. ★ [deepseek] newest work");
    expect(text).toContain("2.   [codex] older work");
    expect(text).toContain("Last active:");
    // Choosing "2" now maps to the *older* session (it was re-sorted to position 2).
    expect(decision).toEqual({ kind: "resume", sessionId: "older" });
  });

  it("exits cleanly on a zero/quit selection", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      { projects: registry, providers: [], sessions: [], knownProviders: KNOWN, cwd: tmp() },
      createScriptedPrompt({ answers: ["q"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
  });
});
