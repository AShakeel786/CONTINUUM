import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher } from "../launcher.js";
import { LocalServiceUnavailableError } from "../errors.js";
import { LocalServiceStartupError } from "../../local-service/manager.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { localOrnith15Manifest } from "../../providers/presets.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import { buildToolRegistry } from "../../mcp/build.js";
import { MEMORY_CORE_ENV_ONLY_ENV } from "../../context/memorycore-config.js";
import type { LauncherDeps } from "../launcher.js";
import type { CredentialBackend } from "../../auth/types.js";

class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "test backend";
  private readonly store = new Map<string, string>();
  async isAvailable() { return true; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async get(k: string) { return this.store.get(k); }
  async delete(k: string) { this.store.delete(k); }
  async list() { return [...this.store.keys()]; }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cont-mli-"));
}

const ornithProfile = manifestToProfile(localOrnith15Manifest);

interface MemRequest {
  readonly path: string;
  readonly agentId: string | null;
  readonly body: Record<string, unknown>;
}

async function buildDeps(opts: {
  dataDir?: string;
  ensureLocalService?: LauncherDeps["ensureLocalService"];
  memoryFetch?: (req: MemRequest) => { ok: boolean; body: unknown };
} = {}): Promise<{ deps: LauncherDeps; registry: ProjectRegistry; memRequests: MemRequest[] }> {
  const dataDir = opts.dataDir ?? tmp();
  const sessionDir = tmp();
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(ornithProfile));

  const credentialManager = new CredentialManager(new FakeBackend());
  const cliAuthManager = new CliAuthManager();
  const authMetadata = createDefaultProviderAuthMetadata();
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));

  const memRequests: MemRequest[] = [];
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
    ensureLocalService: opts.ensureLocalService ?? (async () => ({ kind: "reused-foreign", host: "127.0.0.1", port: 8080 })),
  };

  if (opts.memoryFetch) {
    deps.memoryCore = {
      baseUrl: "http://memcore.test",
      serviceToken: { envVar: "MEMCORE_TOKEN" },
      serviceId: "svc",
      teamId: "team",
      userId: "user",
      agentId: "default",
      resolveToken: async () => "tok",
    };
    vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      const u = new URL(url);
      const req: MemRequest = {
        path: u.pathname,
        agentId: init.headers?.["x-tdai-agent-id"] ?? null,
        body: init.body ? JSON.parse(init.body) : {},
      };
      memRequests.push(req);
      const { ok, body } = opts.memoryFetch!(req);
      return { ok, status: ok ? 200 : 500, json: async () => ({ data: body }), text: async () => JSON.stringify(body) };
    });
  }

  return { deps, registry, memRequests };
}

describe("managed local service auto-start on launch", () => {
  beforeEach(() => { process.env[MEMORY_CORE_ENV_ONLY_ENV] = "1"; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env[MEMORY_CORE_ENV_ONLY_ENV]; });

  it("calls ensureLocalService with the exact resolved Ornith descriptor before preparing the launch", async () => {
    const seen: Array<{ providerId: string; command: string; args: readonly string[]; host: string; port: number }> = [];
    const ensureLocalService: LauncherDeps["ensureLocalService"] = async (descriptor) => {
      seen.push({ providerId: descriptor.providerId, command: descriptor.command, args: descriptor.args, host: descriptor.host, port: descriptor.port });
      return { kind: "started", state: {} as never };
    };
    const { deps, registry } = await buildDeps({ ensureLocalService });
    const p = await registry.add({ name: "svc-proj", path: tmp() });
    const prep = await new Launcher(deps).prepareLaunch({ projectKey: p.id, providerId: "local-ornith15" }, { permissionMode: "safe" });

    expect(prep.runtimeKind).toBe("api");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      providerId: "local-ornith15",
      command: "/Users/home/.venvs/ornith15/bin/python",
      args: ["-m", "mlx_lm", "server", "--model", "/Users/home/Models/Coding/Ornith-1.5-35B-A3B-REAP192-mxfp4-MLX", "--host", "127.0.0.1", "--port", "8080"],
      host: "127.0.0.1",
      port: 8080,
    });
  });

  it("fails the launch loudly (no session opened) when the local server cannot start", async () => {
    const ensureLocalService = vi.fn(async () => {
      throw new LocalServiceStartupError("local-ornith15", "mlx_lm exited before /v1/models became healthy", "Traceback: ...");
    });
    const { deps, registry } = await buildDeps({ ensureLocalService });
    const p = await registry.add({ name: "svc-fail", path: tmp() });
    const launcher = new Launcher(deps);
    await expect(
      launcher.prepareLaunch({ projectKey: p.id, providerId: "local-ornith15" }, { permissionMode: "safe" }),
    ).rejects.toBeInstanceOf(LocalServiceUnavailableError);
    // No session was created for the failed launch.
    expect((await deps.sessionManager.listSessionIds()).length).toBe(0);
  });

  it("does NOT engage the local-service gate for a remote provider", async () => {
    const ensureLocalService = vi.fn(async () => ({ kind: "reused-foreign" as const, host: "127.0.0.1", port: 8080 }));
    const { deps, registry } = await buildDeps({ ensureLocalService });
    const p = await registry.add({ name: "remote-proj", path: tmp(), defaultProvider: "claude" });
    // claude usability requires its CLI; register a fake authed adapter.
    (deps.cliAuthManager as CliAuthManager).register({
      providerId: "claude",
      capability: claudeProfile.cliLaunch as never,
      async detectInstalled() { return "installed"; },
      async detectAuthenticated() { return "authenticated"; },
      async login() { return { completed: true, exitCode: 0 }; },
      async logout() { return { completed: true, exitCode: 0 }; },
    });
    await new Launcher(deps).prepareLaunch({ projectKey: p.id, providerId: "claude" }, { permissionMode: "safe" });
    expect(ensureLocalService).not.toHaveBeenCalled();
  });
});

describe("item 3 — selected project path reaches the API-agent tool runtime", () => {
  beforeEach(() => { process.env[MEMORY_CORE_ENV_ONLY_ENV] = "1"; });
  afterEach(() => { delete process.env[MEMORY_CORE_ENV_ONLY_ENV]; });

  it("prepares an API launch whose project path is the exact registry path (not $HOME)", async () => {
    const { deps, registry } = await buildDeps();
    const projectPath = tmp();
    const p = await registry.add({ name: "bunyan", path: projectPath });
    const prep = await new Launcher(deps).prepareLaunch({ projectKey: p.id, providerId: "local-ornith15" }, { permissionMode: "safe" });

    expect(prep.project.path).toBe(projectPath);
    expect(prep.plan.workingDir).toBe(projectPath);
    const systemText = Array.isArray(prep.rendered.system)
      ? prep.rendered.system.map((b) => b.text).join("\n")
      : prep.rendered.system;
    expect(systemText).toContain(projectPath);
    expect(systemText).not.toContain("Tool surface: chat-only");
  });

  it("the coding harness built from prep.project.path roots exec inside the selected project", async () => {
    const { deps, registry } = await buildDeps();
    const projectPath = tmp();
    const p = await registry.add({ name: "bunyan2", path: projectPath });
    const prep = await new Launcher(deps).prepareLaunch({ projectKey: p.id, providerId: "local-ornith15" }, { permissionMode: "safe" });

    const tools = await buildToolRegistry({ dataDir: tmp(), coding: { projectPath: prep.project.path } });
    const res = await tools.call("exec", { command: process.platform === "win32" ? "cd" : "pwd" });
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain(projectPath);
    expect(text).not.toMatch(/\/Users\/home\s*$/m);
  });
});

describe("item 4 — project memory isolation", () => {
  beforeEach(() => { process.env[MEMORY_CORE_ENV_ONLY_ENV] = "1"; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env[MEMORY_CORE_ENV_ONLY_ENV]; });

  it("scopes recall per project so Project A memory can never surface in Project B", async () => {
    // The fake gateway only returns an atom when the request is scoped to
    // project A's bucket — proving isolation is enforced by the scope key.
    const memoryFetch = (req: MemRequest) => {
      if (req.path.endsWith("/atomic/search") && String(req.agentId).includes("project-")) {
        const forA = String(req.agentId).includes("-A") || String(req.body.agent_id).includes("-A");
        return { ok: true, body: { items: forA ? [{ id: "a1", content: "SECRET-FROM-PROJECT-A" }] : [] } };
      }
      if (req.path.endsWith("/core/read")) return { ok: true, body: { content: "" } };
      if (req.path.endsWith("/scenario/ls")) return { ok: true, body: { entries: [] } };
      return { ok: true, body: { items: [] } };
    };
    const { deps, registry, memRequests } = await buildDeps({ memoryFetch });
    // Force deterministic scope suffixes by using project ids we control via name-derived stubs:
    const a = await registry.add({ name: "proj-A", path: tmp() });
    const b = await registry.add({ name: "proj-B", path: tmp() });
    // Patch ids to carry a stable marker the fake gateway keys on.
    vi.spyOn(deps.projects, "resolve").mockImplementation(async (key: string) => {
      const rec = key === a.id ? a : b;
      return { ...rec, id: rec === a ? "id-A" : "id-B" };
    });

    const launcher = new Launcher(deps);
    const prepA = await launcher.prepareLaunch({ projectKey: a.id, providerId: "local-ornith15", taskGoal: "work on A" }, { permissionMode: "safe" });
    const prepB = await launcher.prepareLaunch({ projectKey: b.id, providerId: "local-ornith15", taskGoal: "work on B" }, { permissionMode: "safe" });

    const scopes = memRequests.map((r) => r.agentId).filter((x): x is string => !!x);
    expect(scopes.every((s) => s.startsWith("project-"))).toBe(true);
    expect(new Set(scopes.map((s) => s))).toEqual(new Set(["project-id-A", "project-id-B"]));
    // The base identity ("default") is never used for a project session.
    expect(scopes).not.toContain("default");

    const renderedA = JSON.stringify(prepA.rendered);
    const renderedB = JSON.stringify(prepB.rendered);
    expect(renderedA).toContain("SECRET-FROM-PROJECT-A");
    expect(renderedB).not.toContain("SECRET-FROM-PROJECT-A");
  });

  it("degrades to NO recalled memory (never the global bucket) when the project-scoped gateway fails", async () => {
    const memoryFetch = () => { throw new Error("gateway down"); };
    const { deps, registry, memRequests } = await buildDeps({
      memoryFetch: memoryFetch as unknown as (r: MemRequest) => { ok: boolean; body: unknown },
    });
    const p = await registry.add({ name: "degraded", path: tmp() });
    const prep = await new Launcher(deps).prepareLaunch({ projectKey: p.id, providerId: "local-ornith15", taskGoal: "go" }, { permissionMode: "safe" });

    expect(prep.memoryCoreNote).toContain("MemoryCore unavailable");
    // Every attempted request was project-scoped; the unscoped "default" bucket
    // was never contacted as a fallback.
    for (const r of memRequests) expect(r.agentId).not.toBe("default");
  });
});
