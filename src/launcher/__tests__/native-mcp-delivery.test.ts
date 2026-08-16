import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher } from "../launcher.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { codexProfile } from "../../providers/profiles/codex.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import type { LauncherDeps } from "../launcher.js";
import type { CliAuthAdapter, CredentialBackend } from "../../auth/types.js";

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

async function buildDeps(): Promise<{ deps: LauncherDeps; registry: ProjectRegistry; sessionManager: SessionManager }> {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-nmd-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-nmd-sess-"));
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

  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));
  const deps: LauncherDeps = {
    projects: registry,
    providers,
    credentialManager,
    cliAuthManager,
    authVerifier: new AuthVerifier({ credentialManager, cliAuthManager }),
    authMetadata: createDefaultProviderAuthMetadata(),
    sessionManager,
    prompt: createScriptedPrompt({}),
    sessionBaseDir: sessionDir,
  };
  return { deps, registry, sessionManager };
}

/** Extract the inline JSON passed to --mcp-config (secret-free). */
function mcpConfigJson(args: readonly string[]): string | undefined {
  const idx = args.indexOf("--mcp-config");
  return idx === -1 ? undefined : args[idx + 1];
}

const SECRET_SHAPED = /sk-[a-zA-Z0-9_-]{8,}|AKID[a-zA-Z0-9]{8,}|-----BEGIN/;

describe("Claude/DeepSeek explicit MCP config delivery", () => {
  it("Claude fresh launch passes --mcp-config with an inline, secret-free continuum server", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "inspect" }, { permissionMode: "safe" });
    const args = prep.plan.args;
    const flagIdx = args.indexOf("--mcp-config");
    expect(flagIdx).toBeGreaterThan(0);
    // Inline JSON (not a file path) — no project-local artifact, no file written.
    const json = args[flagIdx + 1]!;
    expect(json.startsWith("{")).toBe(true);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
    const continuum = parsed.mcpServers["continuum"];
    expect(continuum).toBeDefined();
    expect(continuum!.type).toBe("stdio");
    expect(continuum!.command).toBeTruthy();
    // No secret in the generated MCP config.
    expect(json).not.toMatch(SECRET_SHAPED);
    // Plain --mcp-config (additive), never --strict-mcp-config.
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("DeepSeek (proxy-routed) passes the same --mcp-config shape", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "inspect" }, { permissionMode: "safe" });
    expect(prep.plan.args).toContain("--mcp-config");
    expect(prep.plan.args).not.toContain("--strict-mcp-config");
    expect(mcpConfigJson(prep.plan.args)).not.toMatch(SECRET_SHAPED);
  });

  it("the mcp-config arg is placed before the variadic-safe system flag (not before the positional prompt)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "inspect src/session" }, { permissionMode: "safe" });
    const args = prep.plan.args;
    const mcpIdx = args.indexOf("--mcp-config");
    const sysIdx = args.indexOf("--append-system-prompt");
    // --mcp-config is followed by the system-prompt flag, so the variadic
    // `<configs...>` never swallows the positional task prompt.
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(sysIdx).toBe(mcpIdx + 2);
    expect(args[args.length - 1]).toBe("inspect src/session");
  });
});

describe("resume MCP availability", () => {
  it("claude resume still passes --mcp-config (MCP available on resume too)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(resume.plan.args).toContain("--mcp-config");
    expect(resume.plan.args[0]).toBe("--resume");
  });
});

describe("no project-local config artifacts", () => {
  it("uses inline JSON for --mcp-config, never a file path under the project", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    const json = mcpConfigJson(prep.plan.args);
    expect(json).toBeDefined();
    expect(json!.startsWith("{")).toBe(true); // inline, not a path
    expect(json!).not.toContain("/work/CARS"); // no project-local path leaked
  });
});

describe("Codex unaffected", () => {
  it("Codex (global-config MCP) has no --mcp-config flag", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.plan.args).not.toContain("--mcp-config");
    expect(prep.plan.args).not.toContain("--strict-mcp-config");
  });
});

describe("API-agent unaffected", () => {
  it("bundled providers remain CLI-launched (rendered context still present)", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(prep.runtimeKind).toBe("cli");
    expect(prep.rendered).toBeDefined();
  });
});

describe("no secrets", () => {
  it("the generated --mcp-config JSON is secret-free", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    expect(mcpConfigJson(prep.plan.args)).not.toMatch(SECRET_SHAPED);
  });

  it("the launch env never leaks the upstream API key alongside the proxy key", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "deepseek" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "x" }, { permissionMode: "safe" });
    // Only the proxy key belongs in a proxy-routed launch env; the upstream key
    // (sk-test) must never appear alongside it.
    expect(JSON.stringify(prep.plan.env)).not.toContain("sk-test");
    expect(prep.plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-proxy-test");
  });
});
