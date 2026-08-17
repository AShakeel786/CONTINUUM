import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { Launcher } from "../launcher.js";
import { resolveConfigDir } from "../config-dir.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { manifestToProfile, manifestToAuthMetadata, type ProviderManifest } from "../../providers/manifest.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { LauncherDeps } from "../launcher.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";
import type { LaunchPlan } from "../types.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test";
  private readonly store = new Map<string, string>();
  async isAvailable() { return true; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async get(k: string) { return this.store.get(k); }
  async delete(k: string) { this.store.delete(k); }
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

async function buildDeps(): Promise<{ deps: LauncherDeps; registry: ProjectRegistry; sessionManager: SessionManager; providers: ProviderRegistry }> {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-ncd-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-ncd-sess-"));

  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(codexProfile));

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  await credentialManager.setCredential("deepseek", "api-key", "sk-test");
  await credentialManager.setCredential("deepseek", "proxy-user-key", "sk-proxy-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));
  cliAuthManager.register(fakeCliAdapter("codex"));

  const authMetadata = createDefaultProviderAuthMetadata();
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));

  const deps: LauncherDeps = {
    projects: registry,
    providers,
    credentialManager,
    cliAuthManager,
    authVerifier,
    authMetadata,
    sessionManager,
    prompt: createScriptedPrompt({}),
    sessionBaseDir: sessionDir,
  };

  return { deps, registry, sessionManager, providers };
}

describe("resolveConfigDir", () => {
  it("resolves a bare config-dir name to an absolute home path", () => {
    expect(resolveConfigDir(".claude-tencent")).toBe(join(homedir(), ".claude-tencent"));
    expect(resolveConfigDir(".claude-anthropic")).toBe(join(homedir(), ".claude-anthropic"));
    expect(isAbsolute(resolveConfigDir(".claude-tencent")!)).toBe(true);
  });

  it("expands a leading ~", () => {
    expect(resolveConfigDir("~/x")).toBe(join(homedir(), "x"));
    expect(resolveConfigDir("~")).toBe(homedir());
  });

  it("returns an already-absolute path verbatim (idempotent)", () => {
    expect(resolveConfigDir("/abs/path")).toBe("/abs/path");
    expect(resolveConfigDir(resolveConfigDir(".claude-tencent"))).toBe(join(homedir(), ".claude-tencent"));
  });

  it("returns undefined for no config dir", () => {
    expect(resolveConfigDir(undefined)).toBeUndefined();
  });
});

describe("config-dir resolution on the launch plan", () => {
  it("DeepSeek (direct) resolves to ~/.claude-deepseek (absolute), never a repo-local relative dir", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "inspect" }, { permissionMode: "safe" });
    expect(prep.plan.configDir).toBe(join(homedir(), ".claude-deepseek"));
    expect(isAbsolute(prep.plan.configDir!)).toBe(true);
    expect(prep.plan.configDir).not.toBe(".claude-deepseek");
  });

  it("native Claude resolves to ~/.claude-anthropic (absolute)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "inspect" }, { permissionMode: "safe" });
    expect(prep.plan.configDir).toBe(join(homedir(), ".claude-anthropic"));
    expect(isAbsolute(prep.plan.configDir!)).toBe(true);
  });

  it("Codex has no config dir (native ~/.codex, not CLAUDE_CONFIG_DIR)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "inspect" }, { permissionMode: "safe" });
    expect(prep.plan.configDir).toBeUndefined();
  });
});

describe("native context delivery — Claude-family (--append-system-prompt)", () => {
  it("Claude fresh launch: task as prompt, compact context via --append-system-prompt", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "Inspect src/session" }, { permissionMode: "safe" });
    const args = prep.plan.args;
    expect(args[0]).toBe("--session-id");
    const sysFlagIdx = args.indexOf("--append-system-prompt");
    expect(sysFlagIdx).toBeGreaterThan(0);
    const system = args[sysFlagIdx + 1]!;
    expect(system).toContain("<session-maintenance>");
    expect(system).toContain("<handoff-resume>");
    // The task goal is the positional prompt (last arg).
    expect(args[args.length - 1]).toBe("Inspect src/session");
  });

  it("DeepSeek (proxy-routed, claude executable) delivers the same append-system-prompt shape", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "Inspect src/session" }, { permissionMode: "safe" });
    const args = prep.plan.args;
    expect(prep.plan.executable).toBe("claude");
    expect(args[0]).toBe("--session-id");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.length - 1]).toBe("Inspect src/session");
  });
});

describe("native context delivery — Codex (prompt-only)", () => {
  it("Codex fresh launch folds task + context into a single positional prompt (no system flag)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "Inspect src/session" }, { permissionMode: "safe" });
    const args = prep.plan.args;
    expect(prep.plan.executable).toBe("codex");
    // No session-id flag (Codex has none), so a fresh launch is just [prompt].
    expect(args).toHaveLength(1);
    expect(args[0]).toContain("<session-maintenance>");
    expect(args[0]).toContain("<handoff-resume>");
    expect(args[0]).toContain("Inspect src/session");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("Codex resume: `resume <id> <prompt>` (context delivered after the session id)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "Inspect src/session" }, { permissionMode: "safe" });
    await launcher.recordNativeSessionId(first.session!.sessionId, "codex", "codex-native-1");
    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(resume.plan.args.slice(0, 2)).toEqual(["resume", "codex-native-1"]);
    expect(resume.plan.args[2]).toContain("Inspect src/session");
    expect(resume.plan.args[2]).toContain("<handoff-resume>");
  });
});

describe("resume/handoff context delivery", () => {
  it("same-provider resume delivers accumulated state (completed work + do-not-re-audit)", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    await sessionManager.addCompletedWork(first.session!.sessionId, "built the core");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    const joined = resume.plan.args.join("\n");
    expect(joined).toContain("Do not re-audit");
    expect(joined).toContain("built the core");
  });

  it("cross-provider handoff delivers the handoff-resume block to the receiving CLI", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship the thing" }, { permissionMode: "safe" });
    await sessionManager.recordDecision(first.session!.sessionId, "use snapshot testing");

    // Claude → Codex: the receiving Codex CLI gets the accumulated state folded
    // into its prompt (no session-id flag), plus the do-not-re-audit block.
    const handoff = await launcher.prepareLaunch({ sessionId: first.session!.sessionId, providerId: "codex" }, { permissionMode: "safe" });
    const joined = handoff.plan.args.join("\n");
    expect(handoff.providerRef.providerId).toBe("codex");
    expect(joined).toContain("use snapshot testing");
    expect(joined).toContain("do not re-litigate");
    expect(joined).toContain("ship the thing");
  });
});

describe("API-agent path unchanged", () => {
  it("bundled providers remain CLI-launched, with rendered context still produced (not discarded)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "goal" }, { permissionMode: "safe" });
    expect(prep.runtimeKind).toBe("cli");
    // The same rendered context the API agent would send is still present.
    expect(prep.rendered).toBeDefined();
    expect(JSON.stringify(prep.rendered.system)).toContain("<session-maintenance>");
  });

  it("an API-only provider still resolves to runtimeKind=api (no CLI spawn path)", async () => {
    const grokManifest: ProviderManifest = {
      schemaVersion: 1,
      id: "grok",
      displayName: "Grok",
      protocol: "openai-compatible",
      baseUrl: "https://api.x.ai/v1",
      auth: { kind: "api-key", envVar: "XAI_API_KEY" },
      models: { default: "grok-3" },
    };
    const { deps, registry, providers } = await buildDeps();
    providers.register(createProviderAdapter(manifestToProfile(grokManifest)));
    (deps.authMetadata as Map<string, unknown>).set("grok", manifestToAuthMetadata(grokManifest));
    await deps.credentialManager.setCredential("grok", "api-key", "sk-grok");

    const p = await registry.add({ name: "X", path: "/x", defaultProvider: "grok" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "goal" }, { permissionMode: "safe" });
    expect(prep.runtimeKind).toBe("api");
    expect(prep.rendered).toBeDefined();
  });
});

describe("no repo-local .claude-* creation guard", () => {
  it("the launch plan never carries a relative configDir for Claude-family providers", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "inspect" }, { permissionMode: "safe" });
    const plan: LaunchPlan = prep.plan;
    expect(plan.configDir).toBeDefined();
    expect(isAbsolute(plan.configDir!)).toBe(true);
    expect(plan.configDir).not.toContain("/work/CARS");
  });
});
