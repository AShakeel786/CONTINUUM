import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher } from "../launcher.js";
import { findRecentNativeSessionId } from "../native-session.js";
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
  readonly description = "test backend";
  private readonly store = new Map<string, string>();
  async isAvailable() { return true; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async get(k: string) { return this.store.get(k); }
  async delete(k: string) { this.store.delete(k); }
  async list() { return [...this.store.keys()]; }
}

function fakeCli(providerId: string): CliAuthAdapter {
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
  const dataDir = mkdtempSync(join(tmpdir(), "continuum-nsb-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "continuum-nsb-sess-"));
  const registry = new ProjectRegistry(new ProjectRegistryStore(dataDir));
  const providers = new ProviderRegistry();
  providers.register(createProviderAdapter(claudeProfile));
  providers.register(createProviderAdapter(deepseekProfile));
  providers.register(createProviderAdapter(codexProfile));

  const credentialManager = new CredentialManager(new FakeBackend());
  await credentialManager.setCredential("deepseek", "api-key", "sk-test");
  await credentialManager.setCredential("deepseek", "proxy-user-key", "sk-proxy-test");

  const cliAuthManager = new CliAuthManager();
  cliAuthManager.register(fakeCli("claude"));
  cliAuthManager.register(fakeCli("codex"));

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

/**
 * The native-session args that precede the context-delivery tail. Native CLIs
 * now receive task + context, so `plan.args` is `[...sessionArgs, ...context]`.
 * This extracts just the session-identity head, keeping these tests focused on
 * the native-session bridge rather than the (separately tested) context shape.
 */
function sessionArgsHead(args: readonly string[], providerId: string): readonly string[] {
  if (providerId === "codex") {
    // Codex: `resume <id> <prompt>` or just `<prompt>` (no session flags fresh).
    return args[0] === "resume" ? args.slice(0, 2) : [];
  }
  // Claude/DeepSeek: `[...sessionFlags, "--mcp-config", <json>, "--append-system-prompt", <system>, <task>]`.
  const idx = args.findIndex((a) => a === "--mcp-config" || a === "--append-system-prompt");
  return idx === -1 ? args : args.slice(0, idx);
}

describe("native session bridge — first launch stores id", () => {
  it("recordNativeSessionId persists the provider-native id on the session", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    const sessionId = prep.session!.sessionId;

    await launcher.recordNativeSessionId(sessionId, "codex", "codex-native-uuid-1");

    const reloaded = await sessionManager.loadSession(sessionId);
    expect(reloaded.nativeSessionIds?.codex).toBe("codex-native-uuid-1");
    // No resume args on the FIRST launch (fresh native session); Codex folds
    // task + context into a single positional prompt.
    expect(sessionArgsHead(prep.plan.args, "codex")).toEqual([]);
    expect(prep.plan.args.join("\n")).toContain("ship it");
  });
});

describe("native session bridge — same-provider resume uses native resume", () => {
  it("codex resume injects `resume <id>` and reports nativeResume", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    await launcher.recordNativeSessionId(first.session!.sessionId, "codex", "codex-native-uuid-1");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(sessionArgsHead(resume.plan.args, "codex")).toEqual(["resume", "codex-native-uuid-1"]);
    expect(resume.nativeResume).toEqual({ providerId: "codex", nativeSessionId: "codex-native-uuid-1" });
  });

  it("claude resume injects `--resume <id>`", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    await launcher.recordNativeSessionId(first.session!.sessionId, "claude", "claude-native-uuid-9");

    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(sessionArgsHead(resume.plan.args, "claude")).toEqual(["--resume", "claude-native-uuid-9"]);
  });
});

describe("native session bridge — handoff preserves task, starts fresh target", () => {
  it("Claude→Codex starts a FRESH codex session (no resume args) while preserving the task", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship the thing" }, { permissionMode: "safe" });
    await launcher.recordNativeSessionId(first.session!.sessionId, "claude", "claude-native-uuid-9");

    // Handoff via provider override: the launcher records the transition and
    // sets activeProvider to codex.
    const handoff = await launcher.prepareLaunch({ sessionId: first.session!.sessionId, providerId: "codex" }, { permissionMode: "safe" });
    expect(handoff.providerRef.providerId).toBe("codex");
    // No stored codex native id → fresh codex session (no resume args).
    expect(sessionArgsHead(handoff.plan.args, "codex")).toEqual([]);
    expect(handoff.nativeResume).toBeUndefined();
    // CONTINUUM task preserved.
    expect(handoff.session!.taskGoal).toBe("ship the thing");
  });

  it("Codex→Claude starts a fresh claude session while the source codex id is retained for a later handoff-back", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "task" }, { permissionMode: "safe" });
    await launcher.recordNativeSessionId(first.session!.sessionId, "codex", "codex-native-uuid-1");

    const toClaude = await launcher.prepareLaunch({ sessionId: first.session!.sessionId, providerId: "claude" }, { permissionMode: "safe" });
    // Fresh claude session, but with a deterministic session id (no --resume).
    expect(sessionArgsHead(toClaude.plan.args, "claude")).toEqual(["--session-id", first.session!.sessionId]);
    expect(toClaude.nativeResume).toBeUndefined();
    expect(toClaude.providerRef.providerId).toBe("claude");
    // The codex native id is retained so a later codex handoff can resume it.
    expect((await sessionManager.loadSession(first.session!.sessionId)).nativeSessionIds?.codex).toBe("codex-native-uuid-1");
  });
});

describe("native session bridge — deterministic Claude session identity", () => {
  it("first claude launch sets --session-id = CONTINUUM session id and records it deterministically", async () => {
    const { deps, registry, sessionManager } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const prep = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    const sessionId = prep.session!.sessionId;
    // Deterministic native id (no --resume, no store-scan needed).
    expect(sessionArgsHead(prep.plan.args, "claude")).toEqual(["--session-id", sessionId]);
    expect((await sessionManager.loadSession(sessionId)).nativeSessionIds?.claude).toBe(sessionId);
  });

  it("claude resume with a stored id uses --resume, not --session-id", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "claude" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    const sessionId = first.session!.sessionId;
    // After the deterministic first launch, resume must use --resume <id>.
    const resume = await launcher.prepareLaunch({ sessionId }, { permissionMode: "safe" });
    expect(sessionArgsHead(resume.plan.args, "claude")).toEqual(["--resume", sessionId]);
    expect(resume.nativeResume).toEqual({ providerId: "claude", nativeSessionId: sessionId });
  });

  it("Codex (no session-id flag) still falls back to empty args with no stored id", async () => {
    const { deps, registry } = await buildDeps();
    const p = await registry.add({ name: "CARS", path: "/work/CARS", defaultProvider: "codex" });
    const launcher = new Launcher(deps);
    const first = await launcher.prepareLaunch({ projectKey: p.id, taskGoal: "ship it" }, { permissionMode: "safe" });
    // No capture/record — codex keeps the store-scan fallback, no deterministic id.
    const resume = await launcher.prepareLaunch({ sessionId: first.session!.sessionId }, { permissionMode: "safe" });
    expect(sessionArgsHead(resume.plan.args, "codex")).toEqual([]);
    expect(resume.nativeResume).toBeUndefined();
  });
});

describe("findRecentNativeSessionId — discovery", () => {
  it("returns the most-recent session id at/after sinceMs (basename strategy)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-store-"));
    writeFileSync(join(dir, "a1b2c3d4-1111-2222-3333-444455556666.jsonl"), "{}\n");
    writeFileSync(join(dir, "z9y8x7w6-aaaa-bbbb-cccc-ddddeeeeffff.jsonl"), "{}\n");
    const now = Date.now();
    utimesSync(join(dir, "a1b2c3d4-1111-2222-3333-444455556666.jsonl"), now / 1000, now / 1000 - 5);
    utimesSync(join(dir, "z9y8x7w6-aaaa-bbbb-cccc-ddddeeeeffff.jsonl"), now / 1000, now / 1000);

    const id = await findRecentNativeSessionId({ rootDir: dir, extension: ".jsonl", idFrom: "basename" }, now - 1000);
    expect(id).toBe("z9y8x7w6-aaaa-bbbb-cccc-ddddeeeeffff");
  });

  it("returns undefined when nothing is newer than sinceMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-store-"));
    writeFileSync(join(dir, "old.jsonl"), "{}\n");
    const id = await findRecentNativeSessionId({ rootDir: dir, extension: ".jsonl", idFrom: "basename" }, Date.now() + 60_000);
    expect(id).toBeUndefined();
  });

  it("extracts a trailing UUID for the last-uuid strategy (Codex rollout filenames)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-store-"));
    writeFileSync(join(dir, "rollout-2026-08-16T06-19-26-01a00a15-59c5-7672-8332-c9aad96fad0f.jsonl"), "{}\n");
    const id = await findRecentNativeSessionId({ rootDir: dir, extension: ".jsonl", idFrom: "last-uuid" }, 0);
    expect(id).toBe("01a00a15-59c5-7672-8332-c9aad96fad0f");
  });

  it("never reads file contents — no secret leakage from the store scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-store-"));
    // File content contains a would-be secret; discovery must not surface it.
    writeFileSync(join(dir, "secret-session.jsonl"), '{"api_key":"sk-SHOULD-NOT-LEAK"}\n');
    const id = await findRecentNativeSessionId({ rootDir: dir, extension: ".jsonl", idFrom: "basename" }, 0);
    expect(id).toBe("secret-session");
    expect(id).not.toContain("sk-");
  });

  it("session-meta strategy reads the canonical Codex id (payload.session_id)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-store-"));
    const meta = JSON.stringify({
      ordinal: 0,
      type: "session_meta",
      timestamp: "2026-08-16T10:19:26.559Z",
      payload: { id: "01a00a15-59c5-7672-8332-c9aad96fad0f", session_id: "01a00a15-59c5-7672-8332-c9aad96fad0f", model_provider: "openai" },
    });
    writeFileSync(join(dir, "rollout-2026-08-16T06-19-26-01a00a15-59c5-7672-8332-c9aad96fad0f.jsonl"), meta + "\n");
    const id = await findRecentNativeSessionId({ rootDir: dir, extension: ".jsonl", idFrom: "session-meta", metaRecordType: "session_meta", metaPayloadField: "session_id" }, 0);
    expect(id).toBe("01a00a15-59c5-7672-8332-c9aad96fad0f");
  });

  it("session-meta falls back to filename last-uuid when metadata is unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-store-"));
    // Not valid JSON — the metadata read fails; fall back to the trailing UUID.
    writeFileSync(join(dir, "rollout-2026-08-16T06-19-26-01a00a15-59c5-7672-8332-c9aad96fad0f.jsonl"), "not-json\n");
    const id = await findRecentNativeSessionId({ rootDir: dir, extension: ".jsonl", idFrom: "session-meta", metaRecordType: "session_meta", metaPayloadField: "session_id" }, 0);
    expect(id).toBe("01a00a15-59c5-7672-8332-c9aad96fad0f");
  });

  it("session-meta extracts only session_id, never leaks sibling payload (e.g. a key)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-store-"));
    const meta = JSON.stringify({
      ordinal: 0,
      type: "session_meta",
      payload: { session_id: "canonical-uuid", api_key: "sk-SHOULD-NOT-LEAK" },
    });
    writeFileSync(join(dir, "rollout-x-canonical-uuid.jsonl"), meta + "\n");
    const id = await findRecentNativeSessionId({ rootDir: dir, extension: ".jsonl", idFrom: "session-meta", metaRecordType: "session_meta", metaPayloadField: "session_id" }, 0);
    expect(id).toBe("canonical-uuid");
    expect(id).not.toContain("sk-");
  });
});
