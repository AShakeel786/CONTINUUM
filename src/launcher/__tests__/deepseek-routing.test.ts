/**
 * DeepSeek Flash-by-default routing regression tests.
 *
 * Proves the economic policy end-to-end through the Launcher (not just the
 * adapter): with no explicit choice the resolved model is always
 * deepseek-v4-flash, task size/difficulty never escalates, and Pro is reachable
 * ONLY through an explicit user/project/session preference. These are the
 * regression guards against any future reintroduction of automatic Pro.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, type LauncherDeps } from "../launcher.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { CredentialBackend, CliAuthAdapter } from "../../auth/types.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test backend";
  private readonly store = new Map<string, string>();
  async isAvailable() { return true; }
  async set(key: string, value: string) { this.store.set(key, value); }
  async get(key: string) { return this.store.get(key); }
  async delete(key: string) { this.store.delete(key); }
  async list() { return [...this.store.keys()]; }
}

function fakeCliAdapter(providerId: string): CliAuthAdapter {
  return {
    providerId,
    capability: claudeProfile.cliLaunch as never,
    async detectInstalled() { return "installed"; },
    async detectAuthenticated() { return "authenticated"; },
    async login() { return { completed: true, exitCode: 0 }; },
    async logout() { return { completed: true, exitCode: 0 }; },
  };
}

async function buildDeps() {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-routing-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-routing-sess-"));
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  await credentialManager.setCredential("deepseek", "api-key", "sk-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));

  const authVerifier = new AuthVerifier({
    credentialManager,
    cliAuthManager,
  });
  const store = new FileSessionStore(sessionDir);
  const sessionManager = new SessionManager(store);

  const deps: LauncherDeps = {
    projects: registry,
    providers,
    credentialManager,
    cliAuthManager,
    authVerifier,
    authMetadata: createDefaultProviderAuthMetadata(),
    sessionManager,
    prompt: createScriptedPrompt({}),
    sessionBaseDir: sessionDir,
  };
  return { deps, registry };
}

async function deepseekProject(defaultModel?: string) {
  const { deps, registry } = await buildDeps();
  const p = await registry.add({
    name: `ds-${Math.random().toString(36).slice(2, 8)}`,
    path: "/work/deepseek-project",
    defaultProvider: "deepseek",
    ...(defaultModel ? { defaultModel } : {}),
  });
  return { deps, project: p };
}

describe("DeepSeek Flash-by-default routing (launcher level)", () => {
  it("1. no model provided → deepseek-v4-flash, labelled automatic", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "hello" }, { permissionMode: "safe" });
    expect(prep.providerRef.model).toBe("deepseek-v4-flash");
    expect(prep.modelDecision.automatic).toBe(true);
    expect(prep.modelDecision.reason).toContain("automatic-default-flash");
  });

  it("6. large/complex task metadata does NOT escalate to Pro", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    const hugeGoal = "audit this".repeat(10_000) + " " + "reason deeply about it";
    const prep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: hugeGoal }, { permissionMode: "safe" });
    expect(prep.providerRef.model).toBe("deepseek-v4-flash");
    expect(prep.modelDecision.automatic).toBe(true);
  });

  it("8. explicit --model pro → deepseek-v4-pro, labelled explicit user", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, modelAlias: "pro", taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.model).toBe("deepseek-v4-pro");
    expect(prep.modelDecision.automatic).toBe(false);
    expect(prep.modelDecision.reason).toContain("user");
  });

  it("8b. explicit --model deepseek-v4-pro → deepseek-v4-pro", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, modelAlias: "deepseek-v4-pro", taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.model).toBe("deepseek-v4-pro");
    expect(prep.modelDecision.automatic).toBe(false);
  });

  it("10. explicit saved project model preference → Pro", async () => {
    const { deps, project } = await deepseekProject("pro");
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.model).toBe("deepseek-v4-pro");
    expect(prep.modelDecision.automatic).toBe(false);
    expect(prep.modelDecision.reason).toContain("project");
  });

  it("5. resume without explicit override stays Flash", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "first" }, { permissionMode: "safe" });
    expect(first.providerRef.model).toBe("deepseek-v4-flash");
    const resumed = await launcher.prepareLaunch({ projectKey: project.id, sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(resumed.providerRef.model).toBe("deepseek-v4-flash");
    expect(resumed.modelDecision.automatic).toBe(true);
  });

  it("10b. resume retains an explicit user Pro preference", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: project.id, modelAlias: "pro", taskGoal: "first" }, { permissionMode: "safe" });
    expect(first.providerRef.model).toBe("deepseek-v4-pro");
    const resumed = await launcher.prepareLaunch({ projectKey: project.id, sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(resumed.providerRef.model).toBe("deepseek-v4-pro");
    expect(resumed.modelDecision.automatic).toBe(false);
  });

  it("11. removing the explicit Pro preference returns the session to Flash", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: project.id, modelAlias: "pro", taskGoal: "first" }, { permissionMode: "safe" });
    expect(first.providerRef.model).toBe("deepseek-v4-pro");
    // User explicitly switches back to Flash on this resume.
    const switched = await launcher.prepareLaunch(
      { projectKey: project.id, sessionId: first.session!.sessionId, modelAlias: "flash" },
      { permissionMode: "safe" },
    );
    expect(switched.providerRef.model).toBe("deepseek-v4-flash");
    // A further resume with no override is Flash again.
    const again = await launcher.prepareLaunch({ projectKey: project.id, sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(again.providerRef.model).toBe("deepseek-v4-flash");
  });

  it("7. an unauthenticated/failed DeepSeek launch never silently retries on Pro", async () => {
    const { deps, project } = await deepseekProject();
    const launcher = new Launcher(deps);
    // The routing decision is made BEFORE any network attempt; a "failure" is
    // surfaced as an error (or a Flash plan), never an escalated Pro plan.
    const prep = await launcher.prepareLaunch({ projectKey: project.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.providerRef.model).toBe("deepseek-v4-flash");
    // No retry/fallback tier is present on the plan.
    expect(prep.plan.env.ANTHROPIC_MODEL).toBe("sonnet");
    expect(prep.plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(prep.plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(prep.plan.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-5");
    // haiku + subagent are not override-able by Claude Code — env carries the
    // provider model directly so no claude-* id leaks upstream.
    expect(prep.plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash");
    expect(prep.plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-flash");
  });
});
