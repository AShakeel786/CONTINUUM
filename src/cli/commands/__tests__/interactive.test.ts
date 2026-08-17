import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInteractiveMenu, type InteractiveMenuDeps } from "../interactive.js";
import { createScriptedPrompt } from "../../../auth/prompt.js";
import { ProjectRegistry } from "../../../registry/registry.js";
import { ProjectRegistryStore } from "../../../registry/store.js";
import { normalizeProjectPath } from "../../../registry/registry.js";
import { AgentManager } from "../../../agents/index.js";
import { ConfigStore } from "../../../config/store.js";
import { CredentialManager } from "../../../auth/credential-manager.js";
import { CliAuthManager } from "../../../auth/cli-auth-manager.js";
import { claudeAuthMetadata } from "../../../auth/provider-auth/claude.js";
import { codexAuthMetadata } from "../../../auth/provider-auth/codex.js";
import type { RecentSessionSummary } from "../../../launcher/session-list.js";
import type { CredentialBackend, CliAuthAdapter } from "../../../auth/types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cont-int-"));
}

function session(
  id: string,
  projectId: string | undefined,
  providerId: string,
  goal: string,
  updatedAt = "2026-01-02T00:00:00.000Z",
  overrides: Partial<RecentSessionSummary> = {},
): RecentSessionSummary {
  return {
    sessionId: id,
    ...(projectId ? { projectId } : {}),
    mode: "project",
    workingDirectory: "/w",
    providerId,
    taskGoal: goal,
    status: "active",
    updatedAt,
    ...overrides,
  };
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

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "in-memory test backend";
  private readonly store = new Map<string, string>();
  async isAvailable(): Promise<boolean> { return true; }
  async set(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async get(key: string): Promise<string | undefined> { return this.store.get(key); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async list(): Promise<readonly string[]> { return [...this.store.keys()]; }
}

function fakeAdapter(providerId: string, capability: CliAuthAdapter["capability"]): CliAuthAdapter {
  return {
    providerId,
    capability,
    async detectInstalled() { return "installed"; },
    async detectAuthenticated() { return "authenticated"; },
    async login() { return { completed: true, exitCode: 0 }; },
    async logout() { return { completed: true, exitCode: 0 }; },
  };
}

function makeAgentManager(dataDir: string): AgentManager {
  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeAdapter("claude", claudeAuthMetadata.cli as never));
  cliAuthManager.register(fakeAdapter("codex", codexAuthMetadata.cli as never));
  return new AgentManager({
    dataDir,
    configStore: new ConfigStore(dataDir),
    credentialManager: new CredentialManager(new FakeBackend()),
    prompt: createScriptedPrompt({}),
    buildCliAuthManager: () => cliAuthManager,
    // DeepSeek's `claude` executable is not on this test's PATH → "not installed"
    // deterministically (no host-dependent CLI detection in the menu tests).
    findExecutable: () => undefined,
  });
}

function deps(registry: ProjectRegistry, agentManager: AgentManager, sessions: RecentSessionSummary[], cwd: string): InteractiveMenuDeps {
  return { projects: registry, sessions, agentManager, cwd };
}

describe("runInteractiveMenu — main menu", () => {
  it("prints the header exactly once and routes Start new task", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const alpha = (await registry.list())[0]!;
    const cap = capture();
    const decision = await runInteractiveMenu(
      // Start new task → workspace #3 (General, Current directory, then Alpha) → agent #1 → goal.
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      createScriptedPrompt({ answers: ["1", "3", "1", "ship it"] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "new", projectId: alpha.id, providerId: "claude", taskGoal: "ship it" });
    expect((cap.text().match(/CONTINUUM/g) ?? []).length).toBe(1);
    expect(cap.text()).toContain("1. Start new task");
    expect(cap.text()).toContain("4. Manage AI agents");
  });

  it("routes Resume session", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const alpha = (await registry.list())[0]!;
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [session("s1", alpha.id, "codex", "fix bug")], tmp()),
      createScriptedPrompt({ answers: ["2", "1"] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "resume", sessionId: "s1" });
  });

  it("shows the registered project name in the resume picker", async () => {
    const registry = await makeRegistry([{ name: "PASSCARS", path: tmp() }]);
    const passcars = (await registry.list())[0]!;
    const cap = capture();
    await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [session("s1", passcars.id, "deepseek", "Fix exam selector")], tmp()),
      createScriptedPrompt({ answers: ["2", "q"] }),
      cap.out,
    );
    expect(cap.text()).toContain("★ [PASSCARS] [deepseek] Fix exam selector");
  });

  it("distinguishes sessions with the same agent and title across different projects", async () => {
    const registry = await makeRegistry([
      { name: "PASSCARS", path: tmp() },
      { name: "CONTINUUM", path: tmp() },
    ]);
    const [passcars, continuum] = await registry.list();
    const cap = capture();
    await runInteractiveMenu(
      deps(
        registry,
        makeAgentManager(tmp()),
        [
          session("s1", passcars!.id, "codex", "inspect src/session", "2026-08-17T00:00:00.000Z"),
          session("s2", continuum!.id, "codex", "inspect src/session", "2026-08-16T00:00:00.000Z"),
        ],
        tmp(),
      ),
      createScriptedPrompt({ answers: ["2", "q"] }),
      cap.out,
    );
    const text = cap.text();
    expect(text).toContain("[PASSCARS] [codex] inspect src/session");
    expect(text).toContain("[CONTINUUM] [codex] inspect src/session");
  });

  it("shows [Unknown project] for a legacy session with no resolvable project metadata", async () => {
    const registry = await makeRegistry([{ name: "PASSCARS", path: tmp() }]);
    const cap = capture();
    await runInteractiveMenu(
      deps(
        registry,
        makeAgentManager(tmp()),
        // No projectId, and a workingDirectory that matches no registered project path.
        [session("s1", undefined, "codex", "orphaned session", undefined, { workingDirectory: "/nowhere" })],
        tmp(),
      ),
      createScriptedPrompt({ answers: ["2", "q"] }),
      cap.out,
    );
    expect(cap.text()).toContain("[Unknown project] [codex] orphaned session");
  });

  it("resolves a legacy session with no projectId via a matching registered project path", async () => {
    const projectDir = tmp();
    const registry = await makeRegistry([{ name: "PASSCARS", path: projectDir }]);
    const cap = capture();
    await runInteractiveMenu(
      deps(
        registry,
        makeAgentManager(tmp()),
        [session("s1", undefined, "codex", "pre-migration session", undefined, { workingDirectory: projectDir })],
        tmp(),
      ),
      createScriptedPrompt({ answers: ["2", "q"] }),
      cap.out,
    );
    expect(cap.text()).toContain("[PASSCARS] [codex] pre-migration session");
  });

  it("reflects a project rename immediately (name resolved live, never persisted on the session)", async () => {
    const registry = await makeRegistry([{ name: "OldName", path: tmp() }]);
    const project = (await registry.list())[0]!;
    await registry.update(project.id, { name: "NewName" });
    const cap = capture();
    await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [session("s1", project.id, "codex", "rename check")], tmp()),
      createScriptedPrompt({ answers: ["2", "q"] }),
      cap.out,
    );
    expect(cap.text()).toContain("[NewName] [codex] rename check");
    expect(cap.text()).not.toContain("OldName");
  });

  it("exits cleanly on zero/quit at the main menu", async () => {
    const registry = await makeRegistry();
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      createScriptedPrompt({ answers: ["q"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
  });
});

describe("runInteractiveMenu — start new task", () => {
  it("lists every agent with a distinct state and routes a ready agent to launch", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      // Start new → workspace #3 (Alpha, after General/Current directory) → agent #1 (claude) → goal
      createScriptedPrompt({ answers: ["1", "3", "1", "do it"] }),
      cap.out,
    );
    expect(decision.kind).toBe("new");
    const text = cap.text();
    expect(text).toContain("1. Claude");
    expect(text).toContain("Ready");
    // DeepSeek is listed (not silently hidden) and marked not-installed.
    expect(text).toContain("DeepSeek");
    expect(text).toContain("Not installed");
  });

  it("offers General / No Project as the first workspace choice with no project registration", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      // Start new → workspace #1 (General) → agent #1 (claude) → goal
      createScriptedPrompt({ answers: ["1", "1", "1", "explore something"] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "new", mode: "general", providerId: "claude", taskGoal: "explore something" });
    expect(cap.text()).toContain("General / No Project");
    // The workspace choice must never register a project.
    expect(await registry.list()).toHaveLength(1);
  });

  it("offers Current Directory as the second workspace choice, anchored to launch cwd, with no project registration", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const launchCwd = tmp();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], launchCwd),
      // Start new → workspace #2 (Current directory) → agent #1 (claude) → goal
      createScriptedPrompt({ answers: ["1", "2", "1", "quick fix"] }),
      cap.out,
    );
    expect(decision).toEqual({ kind: "new", mode: "current-directory", providerId: "claude", taskGoal: "quick fix" });
    expect(cap.text()).toContain("Current Directory");
    expect(cap.text()).toContain(launchCwd);
    expect(await registry.list()).toHaveLength(1);
  });
});

describe("runInteractiveMenu — manage projects", () => {
  it("adds a project via Manage projects", async () => {
    const registry = await makeRegistry();
    const projPath = tmp();
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      createScriptedPrompt({ answers: ["3", "1", "myproj", projPath, "", "0", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    const list = await registry.list();
    expect(list.map((p) => p.name)).toEqual(["myproj"]);
    expect(list[0]!.path).toBe(normalizeProjectPath(projPath));
    expect(cap.text()).toContain('✓ Added project "myproj"');
  });

  it("lists projects via Manage projects", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      createScriptedPrompt({ answers: ["3", "3", "0", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect(cap.text()).toContain("- Alpha");
  });

  it("removes a project (folder never touched) via Manage projects", async () => {
    const projPath = tmp();
    const registry = await makeRegistry([{ name: "Alpha", path: projPath }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      createScriptedPrompt({ answers: ["3", "2", "1", "0", "0"], confirms: [true] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    expect(await registry.list()).toHaveLength(0);
    expect(cap.text()).toContain('✓ Removed "Alpha"');
    expect(cap.text()).toContain("folder was not touched");
  });
});

describe("runInteractiveMenu — manage AI agents", () => {
  it("lists agents via Manage AI agents", async () => {
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(await makeRegistry(), makeAgentManager(tmp()), [], tmp()),
      // Main menu #4 = Manage AI agents → #6 = List agents → #0 back → #0 exit.
      createScriptedPrompt({ answers: ["4", "6", "0", "0"] }),
      cap.out,
    );
    expect(decision.kind).toBe("exit");
    const text = cap.text();
    expect(text).toContain("AI agents:");
    expect(text).toContain("Claude");
    expect(text).toContain("Codex");
    expect(text).toContain("DeepSeek");
  });
});
