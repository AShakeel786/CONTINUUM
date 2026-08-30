/**
 * Model-verify preflight tests (the `modelVerify` launch descriptor).
 *
 * Regression guard for the OpenRouter wire-model incident: the provider's
 * wire model — `stealth/ox-alpha` under the retired "Ox Alpha Free" identity,
 * now `z-ai/glm-5.2:free` under "GLM 5.2 Free (OpenRouter)" — was retired
 * upstream, and every prompt failed with
 * "There's an issue with the selected model" AFTER the session opened. The
 * preflight confirms the resolved wire model still exists in the provider's
 * catalog BEFORE any session is created or mutated, so a retired model fails
 * loudly at launch instead of after.
 *
 * The catalog is served by a local `node:http` server — the real
 * `verifyWireModel` implementation runs against it, so no live network and no
 * seeded seam (deterministic and fast).
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, type LauncherDeps } from "../launcher.js";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { glm52FreeManifest } from "../../providers/presets.js";
import { manifestToProfile, type ManifestCliLaunch } from "../../providers/manifest.js";
import { CredentialManager } from "../../auth/credential-manager.js";
import { CliAuthManager } from "../../auth/cli-auth-manager.js";
import { AuthVerifier } from "../../auth/auth-verifier.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderAuthMetadata } from "../../auth/provider-auth/index.js";
import { createScriptedPrompt } from "../../auth/prompt.js";
import { ModelUnavailableError } from "../errors.js";
import type { CredentialBackend, CliAuthAdapter } from "../../auth/types.js";
import type { CliLaunchDescriptor, ProviderProfile } from "../../providers/types.js";

const WIRE = "z-ai/glm-5.2:free";
const CATALOG = {
  data: [{ id: WIRE, name: "GLM-5.2 Free" }, { id: "z-ai/glm-5.2", name: "GLM-5.2" }],
};

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

/** Serve `catalog` (or `status` when set, to simulate a transient 5xx). */
async function withCatalogServer(
  catalog: unknown,
  status: number | undefined,
  fn: (baseUrl: string, hits: () => number) => Promise<void>,
): Promise<void> {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    res.setHeader("content-type", "application/json");
    if (status !== undefined) {
      res.writeHead(status);
      res.end("{}");
      return;
    }
    res.end(JSON.stringify(catalog));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, () => requests);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

interface BuildOpts {
  readonly wireModel?: string;
  readonly bestEffort?: boolean;
  readonly verifyWireModel?: (launch: CliLaunchDescriptor, profile: ProviderProfile, wireModel: string) => Promise<string | undefined>;
}

async function buildDeps(opts: BuildOpts = {}, catalogUrl: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-mv-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-mv-sess-"));
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(
    createProviderAdapter(
      manifestToProfile({
        ...glm52FreeManifest,
        models: { default: opts.wireModel ?? WIRE },
        cliLaunch: {
          ...(glm52FreeManifest.cliLaunch as Extract<ManifestCliLaunch, { kind: "redirected" }>),
          modelVerify: {
            catalogUrl,
            listPath: "data",
            idField: "id",
            ...(opts.bestEffort ? { bestEffort: true } : {}),
          },
        },
      }),
    ),
  );

  const backend = new FakeBackend();
  const credentialManager = new CredentialManager(backend);
  await credentialManager.setCredential("glm-5-2-free", "api-key", "sk-ox-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCliAdapter("claude"));
  const authVerifier = new AuthVerifier({ credentialManager, cliAuthManager });
  const sessionManager = new SessionManager(new FileSessionStore(sessionDir));
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
    preferredProviderChain: ["glm-5-2-free", "deepseek"],
    findExecutable: (e: string) => (e === "claude" ? "/fake/claude" : undefined),
    ...(opts.verifyWireModel ? { verifyWireModel: opts.verifyWireModel } : {}),
    seedConfigDirFlag: async () => {},
    seedConfigDirOnboarding: async () => {},
    seedConfigDirProjectTrust: async () => {},
  };
  const project = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ox" });
  return { deps, project, sessionDir };
}

describe("model-verify preflight (declared `modelVerify` on the launch descriptor)", () => {
  it("proceeds when the wire model IS in the catalog (real preflight against a local server)", async () => {
    await withCatalogServer(CATALOG, undefined, async (base) => {
      const { deps, project } = await buildDeps({}, `${base}/models`);
      const prep = await new Launcher(deps).prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {});
      expect(prep.providerRef.model).toBe(WIRE);
      expect(prep.modelNote).toBeUndefined();
    });
  });

  it("hard-fails with ModelUnavailableError BEFORE creating a session when the wire model is gone", async () => {
    await withCatalogServer(CATALOG, undefined, async (base) => {
      const { deps, project, sessionDir } = await buildDeps({ wireModel: "stealth/ox-alpha" }, `${base}/models`);
      const launcher = new Launcher(deps);
      await expect(
        launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {}),
      ).rejects.toBeInstanceOf(ModelUnavailableError);
      await expect(
        launcher.prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {}),
      ).rejects.toThrow(/stealth\/ox-alpha.*no longer available/);
      // No session was created or mutated — the failure happened before
      // prepareLaunch's session-identity step.
      expect(readdirSync(sessionDir)).toEqual([]);
    });
  });

  it("degrades to proceed on a transient upstream failure (5xx) — never blocks the launch", async () => {
    await withCatalogServer({}, 500, async (base) => {
      const { deps, project } = await buildDeps({ wireModel: "stealth/ox-alpha" }, `${base}/models`);
      const prep = await new Launcher(deps).prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {});
      expect(prep.providerRef.model).toBe("stealth/ox-alpha");
    });
  });

  it("degrades to proceed on an unparseable catalog", async () => {
    await withCatalogServer({ nope: true }, undefined, async (base) => {
      const { deps, project } = await buildDeps({ wireModel: "stealth/ox-alpha" }, `${base}/models`);
      const prep = await new Launcher(deps).prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {});
      expect(prep.providerRef.model).toBe("stealth/ox-alpha");
    });
  });

  it("bestEffort: a confirmed absence downgrades to a visible note, still proceeds", async () => {
    await withCatalogServer(CATALOG, undefined, async (base) => {
      const { deps, project } = await buildDeps({ wireModel: "stealth/ox-alpha", bestEffort: true }, `${base}/models`);
      const prep = await new Launcher(deps).prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {});
      expect(prep.providerRef.model).toBe("stealth/ox-alpha");
      expect(prep.modelNote).toContain("stealth/ox-alpha");
      expect(prep.modelNote).toContain("best-effort");
    });
  });

  it("no descriptor → the preflight is a no-op (launch proceeds, no note)", async () => {
    await withCatalogServer(CATALOG, undefined, async (base, hits) => {
      // DeepSeek declares no modelVerify: the preflight must neither fetch nor
      // alter the launch, even with a catalog URL reachable at `base`.
      const dataDir = mkdtempSync(join(tmpdir(), "continuum-mv-nv-"));
      const sessionDir = mkdtempSync(join(tmpdir(), "continuum-mv-nv-sess-"));
      const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
      const providers = new ProviderRegistry();
      providers.register(createProviderAdapter(claudeProfile));
      providers.register(createProviderAdapter(deepseekProfile));
      const credentialManager = new CredentialManager(new FakeBackend());
      await credentialManager.setCredential("deepseek", "api-key", "sk-ds-test");
      const cliAuthManager = new CliAuthManager();
      cliAuthManager.register(fakeCliAdapter("claude"));
      const deps: LauncherDeps = {
        projects: registry,
        providers,
        credentialManager,
        cliAuthManager,
        authVerifier: new AuthVerifier({ credentialManager, cliAuthManager }),
        authMetadata: createDefaultProviderAuthMetadata(),
        sessionManager: new SessionManager(new FileSessionStore(sessionDir)),
        prompt: createScriptedPrompt({}),
        sessionBaseDir: sessionDir,
        preferredProviderChain: ["deepseek"],
        findExecutable: (e: string) => (e === "claude" ? "/fake/claude" : undefined),
        seedConfigDirFlag: async () => {},
        seedConfigDirOnboarding: async () => {},
        seedConfigDirProjectTrust: async () => {},
      };
      const project = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ds", defaultProvider: "deepseek" });
      const prep = await new Launcher(deps).prepareLaunch({ projectKey: project.id, taskGoal: "x" }, {});
      expect(prep.providerRef.providerId).toBe("deepseek");
      expect(prep.modelNote).toBeUndefined();
      expect(hits()).toBe(0); // deepseek's descriptor declares no modelVerify
    });
  });

  it("honors the verifyWireModel deps seam: a thrown ModelUnavailableError aborts before any session", async () => {
    const { deps, project, sessionDir } = await buildDeps(
      { verifyWireModel: async () => { throw new ModelUnavailableError("glm-5-2-free", WIRE, "seam test"); } },
      "http://127.0.0.1:1/models", // never reached — the seam short-circuits
    );
    await expect(
      new Launcher(deps).prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {}),
    ).rejects.toThrow(/no longer available/);
    expect(readdirSync(sessionDir)).toEqual([]);
  });

  it("honors the verifyWireModel deps seam: a returned note surfaces as modelNote", async () => {
    const { deps, project } = await buildDeps(
      { verifyWireModel: async () => "seam warning" },
      "http://127.0.0.1:1/models",
    );
    const prep = await new Launcher(deps).prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {});
    expect(prep.modelNote).toBe("seam warning");
  });

  it("skips the preflight entirely for an API-harness run (no CLI, no fetch)", async () => {
    await withCatalogServer(CATALOG, undefined, async (base, hits) => {
      const dataDir = mkdtempSync(join(tmpdir(), "continuum-mv-api-"));
      const sessionDir = mkdtempSync(join(tmpdir(), "continuum-mv-api-sess-"));
      const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
      const providers = new ProviderRegistry();
      providers.register(createProviderAdapter(manifestToProfile({
        ...glm52FreeManifest,
        models: { default: WIRE },
        cliLaunch: { ...(glm52FreeManifest.cliLaunch as Extract<ManifestCliLaunch, { kind: "redirected" }>), modelVerify: { catalogUrl: `${base}/models`, listPath: "data" } },
      })));
      const credentialManager = new CredentialManager(new FakeBackend());
      await credentialManager.setCredential("glm-5-2-free", "api-key", "sk-ox-test");
      const cliAuthManager = new CliAuthManager();
      const deps: LauncherDeps = {
        projects: registry,
        providers,
        credentialManager,
        cliAuthManager,
        authVerifier: new AuthVerifier({ credentialManager, cliAuthManager }),
        authMetadata: createDefaultProviderAuthMetadata(),
        sessionManager: new SessionManager(new FileSessionStore(sessionDir)),
        prompt: createScriptedPrompt({}),
        sessionBaseDir: sessionDir,
        preferredProviderChain: ["glm-5-2-free"],
        findExecutable: () => undefined, // no claude → API harness
        seedConfigDirFlag: async () => {},
        seedConfigDirOnboarding: async () => {},
        seedConfigDirProjectTrust: async () => {},
      };
      const project = await registry.add({ name: `p-${Math.random().toString(36).slice(2, 8)}`, path: "/work/ox" });
      const prep = await new Launcher(deps).prepareLaunch({ projectKey: project.id, providerId: "glm-5-2-free", taskGoal: "hello" }, {});
      expect(prep.runtimeKind).toBe("api");
      expect(hits()).toBe(0); // preflight is CLI-harness only
    });
  });
});
