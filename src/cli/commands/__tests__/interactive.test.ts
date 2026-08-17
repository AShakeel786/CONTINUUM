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
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      createScriptedPrompt({ answers: ["1", "1", "1", "ship it"] }),
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
  it("offers only usable agents and surfaces a disabled reason", async () => {
    const registry = await makeRegistry([{ name: "Alpha", path: tmp() }]);
    const cap = capture();
    const decision = await runInteractiveMenu(
      deps(registry, makeAgentManager(tmp()), [], tmp()),
      // Start new → project Alpha → agent #1 (claude; deepseek is unusable) → goal
      createScriptedPrompt({ answers: ["1", "1", "1", "do it"] }),
      cap.out,
    );
    expect(decision.kind).toBe("new");
    const text = cap.text();
    expect(text).toContain("DeepSeek unavailable");
    expect(text).toContain("1. Claude");
    expect(text).not.toContain("1. DeepSeek");
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
      createScriptedPrompt({ answers: ["4", "4", "0", "0"] }),
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
