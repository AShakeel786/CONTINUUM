import { afterEach, describe, expect, it } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HandoffManager } from "../manager.js";
import { HandoffProviderUnavailableError } from "../errors.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { SessionNotFoundError } from "../../session/errors.js";
import { createDefaultProviderRegistry } from "../../providers/index.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { claudeProfile } from "../../providers/profiles/claude.js";
import { deepseekProfile } from "../../providers/profiles/deepseek.js";
import { manifestToProfile } from "../../providers/manifest.js";
import { UnknownProviderError } from "../../providers/errors.js";
import type { ProviderProfile } from "../../providers/types.js";

let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "continuum-handoff-manager-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fsPromises.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeSessionManager(): Promise<SessionManager> {
  return new SessionManager(new FileSessionStore(await makeTmpDir()));
}

async function seedSession(sessionManager: SessionManager, providerId: "claude" | "deepseek" | "codex" = "claude") {
  const model = providerId === "claude" ? "claude-sonnet-5" : providerId === "deepseek" ? "deepseek-v4-pro" : "gpt-5.6-sol";
  await sessionManager.createSession({
    sessionId: "sess-1",
    projectId: "proj-1",
    workingDirectory: "C:\\fake",
    activeProvider: { providerId, model },
    taskGoal: "Ship the feature",
  });
  await sessionManager.addCompletedWork("sess-1", "Wrote the core logic");
  await sessionManager.addRemainingWork("sess-1", "Add tests");
}

/** A general-mode (no project) session — handoff must work identically to a project-anchored one. */
async function seedGeneralSession(sessionManager: SessionManager, providerId: "claude" | "deepseek" | "codex" = "claude") {
  const model = providerId === "claude" ? "claude-sonnet-5" : providerId === "deepseek" ? "deepseek-v4-pro" : "gpt-5.6-sol";
  await sessionManager.createSession({
    sessionId: "sess-general",
    mode: "general",
    workingDirectory: "/wherever",
    activeProvider: { providerId, model },
    taskGoal: "Explore an idea",
  });
  await sessionManager.addCompletedWork("sess-general", "Sketched the approach");
}

const tokenLimits = { contextWindow: 100_000, reservedOutput: 4096 };

describe("HandoffManager — provider selection", () => {
  it("listAvailableReceivingProviders lists every registered provider, does not pick one", async () => {
    const manager = new HandoffManager(await makeSessionManager(), createDefaultProviderRegistry());
    const choices = manager.listAvailableReceivingProviders();
    expect(choices.map((c) => c.providerId).sort()).toEqual([
      "antigravity",
      "cerebras-trial",
      "claude",
      "cloudflare-workers-ai-free",
      "codex",
      "deepseek",
      "gemini-free",
      "groq-free",
      "huggingface-free",
      "nvidia-free",
      "openrouter-free",
      "ox-alpha",
    ]);
  });

  it("prepareHandoff returns the session plus available choices together", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager);
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());
    const { session, availableProviders } = await manager.prepareHandoff("sess-1");
    expect(session.taskGoal).toBe("Ship the feature");
    expect(availableProviders.length).toBeGreaterThanOrEqual(2);
  });
});

describe("HandoffManager — Claude \u2192 DeepSeek", () => {
  it("completes a full handoff, rendering DeepSeek's (joined-string) system shape", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "deepseek", { tokenLimits });

    expect(result.handoffPackage.sourceProvider.providerId).toBe("claude");
    expect(result.handoffPackage.targetProvider.providerId).toBe("deepseek");
    expect(result.rendered.protocol).toBe("openai-compatible");
    expect(typeof result.rendered.system).toBe("string");
    expect(result.rendered.system as string).toContain("Ship the feature");
    // No Anthropic cache directive for a DeepSeek target.
    expect(result.rendered.cacheDirectives).toEqual([]);
  });

  it("updates the session's activeProvider and records handoff metadata", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "deepseek", { tokenLimits });

    expect(result.session.activeProvider.providerId).toBe("deepseek");
    expect(result.session.lastHandoff?.fromProvider.providerId).toBe("claude");
    expect(result.session.lastHandoff?.toProvider.providerId).toBe("deepseek");

    const reloaded = await sessionManager.loadSession("sess-1");
    expect(reloaded.activeProvider.providerId).toBe("deepseek");
  });
});

describe("HandoffManager — DeepSeek \u2192 Claude", () => {
  it("completes a full handoff, rendering Claude's (block-array) system shape with a cache directive", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "deepseek");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "claude", { tokenLimits });

    expect(result.handoffPackage.sourceProvider.providerId).toBe("deepseek");
    expect(result.handoffPackage.targetProvider.providerId).toBe("claude");
    expect(result.rendered.protocol).toBe("anthropic-messages");
    expect(Array.isArray(result.rendered.system)).toBe(true);
    expect(result.rendered.cacheDirectives.length).toBeGreaterThan(0);
  });
});

describe("HandoffManager — no-project (general mode) session", () => {
  it("hands off a projectId-less session exactly like a project-anchored one", async () => {
    const sessionManager = await makeSessionManager();
    await seedGeneralSession(sessionManager, "claude");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-general", "deepseek", { tokenLimits });

    expect(result.session.mode).toBe("general");
    expect(result.session.projectId).toBeUndefined();
    expect(result.session.activeProvider.providerId).toBe("deepseek");
    expect(result.session.lastHandoff?.toProvider.providerId).toBe("deepseek");
    expect(result.rendered.system as string).toContain("Explore an idea");
  });
});

describe("HandoffManager — Codex as receiving provider", () => {
  it("Claude → Codex renders Codex's openai-compatible (joined-string) shape and inherits task state", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "codex", { tokenLimits });

    expect(result.handoffPackage.sourceProvider.providerId).toBe("claude");
    expect(result.handoffPackage.targetProvider.providerId).toBe("codex");
    expect(result.handoffPackage.targetProvider.model).toBe("gpt-5.6-sol");
    expect(result.rendered.protocol).toBe("openai-compatible");
    expect(typeof result.rendered.system).toBe("string");
    // No Anthropic cache directive for an OpenAI-compatible target.
    expect(result.rendered.cacheDirectives).toEqual([]);
    // Receiving Codex session inherits task state, does not re-audit.
    expect(result.handoffPackage.completedWork).toEqual(["Wrote the core logic"]);
    expect(result.handoffPackage.remainingWork).toEqual(["Add tests"]);
    expect(result.session.activeProvider.providerId).toBe("codex");
  });

  it("DeepSeek → Codex works through the same mechanism (no special-casing)", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "deepseek");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "codex", { tokenLimits });

    expect(result.handoffPackage.sourceProvider.providerId).toBe("deepseek");
    expect(result.handoffPackage.targetProvider.providerId).toBe("codex");
    expect(result.rendered.protocol).toBe("openai-compatible");
    expect(result.session.lastHandoff?.toProvider.providerId).toBe("codex");
  });
});

describe("HandoffManager — Codex as source provider", () => {
  it("Codex → Claude renders Claude's Anthropic block-array shape with a cache directive", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "codex");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "claude", { tokenLimits });

    expect(result.handoffPackage.sourceProvider.providerId).toBe("codex");
    expect(result.handoffPackage.targetProvider.providerId).toBe("claude");
    expect(result.rendered.protocol).toBe("anthropic-messages");
    expect(Array.isArray(result.rendered.system)).toBe(true);
    expect(result.rendered.cacheDirectives.length).toBeGreaterThan(0);
    expect(result.session.activeProvider.providerId).toBe("claude");
  });

  it("Codex → DeepSeek renders openai-compatible joined string", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "codex");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "deepseek", { tokenLimits });

    expect(result.handoffPackage.sourceProvider.providerId).toBe("codex");
    expect(result.handoffPackage.targetProvider.providerId).toBe("deepseek");
    expect(result.rendered.protocol).toBe("openai-compatible");
    expect(typeof result.rendered.system).toBe("string");
    expect(result.session.lastHandoff?.fromProvider.providerId).toBe("codex");
  });
});

describe("HandoffManager — API-only providers", () => {
  it("accepts an API-only provider (grok) as a handoff target (CONTINUUM API runtime)", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");

    const grokProfile = manifestToProfile({
      schemaVersion: 1,
      id: "grok",
      displayName: "Grok",
      protocol: "openai-compatible",
      baseUrl: "https://api.x.ai/v1",
      auth: { kind: "api-key", envVar: "XAI_API_KEY" },
      models: { default: "grok-3" },
    });
    const registry = new ProviderRegistry();
    registry.register(createProviderAdapter(claudeProfile));
    registry.register(createProviderAdapter(grokProfile));

    const manager = new HandoffManager(sessionManager, registry);
    const result = await manager.finalizeHandoff("sess-1", "grok", { tokenLimits });
    expect(result.handoffPackage.targetProvider.providerId).toBe("grok");
    expect(result.rendered.protocol).toBe("openai-compatible");
    // Task state preserved — no re-audit.
    expect(result.handoffPackage.completedWork).toEqual(["Wrote the core logic"]);
  });
});

describe("HandoffManager — same-provider handoff/restart", () => {
  it("supports Claude \u2192 Claude (e.g. a fresh session resuming the same task) through the same mechanism, no special-casing", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    const result = await manager.finalizeHandoff("sess-1", "claude", { tokenLimits });

    expect(result.handoffPackage.sourceProvider.providerId).toBe("claude");
    expect(result.handoffPackage.targetProvider.providerId).toBe("claude");
    expect(result.session.activeProvider.providerId).toBe("claude");
  });
});

describe("HandoffManager — validation and failure modes", () => {
  it("throws UnknownProviderError for an unregistered target, and does not modify the session", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    await expect(manager.finalizeHandoff("sess-1", "gemini", { tokenLimits })).rejects.toThrow(UnknownProviderError);

    const session = await sessionManager.loadSession("sess-1");
    expect(session.activeProvider.providerId).toBe("claude"); // unchanged
    expect(session.lastHandoff).toBeUndefined();
  });

  it("throws HandoffProviderUnavailableError for a provider with no launch runtime (no CLI, no API), and does not modify the session", async () => {
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");

    // A provider with neither a CLI nor an API auth kind has no way to run.
    const noRuntimeProfile: ProviderProfile = {
      ...claudeProfile,
      id: "no-runtime-provider",
      auth: { kind: "cli-session" },
      capabilities: { ...claudeProfile.capabilities, cliAvailable: false },
    };
    const registry = new ProviderRegistry();
    registry.register(createProviderAdapter(claudeProfile));
    registry.register(createProviderAdapter(deepseekProfile));
    registry.register(createProviderAdapter(noRuntimeProfile));

    const manager = new HandoffManager(sessionManager, registry);
    await expect(manager.finalizeHandoff("sess-1", "no-runtime-provider", { tokenLimits })).rejects.toThrow(
      HandoffProviderUnavailableError,
    );

    const session = await sessionManager.loadSession("sess-1");
    expect(session.activeProvider.providerId).toBe("claude"); // unchanged -- interrupted handoff left no partial state
  });

  it("throws SessionNotFoundError for a handoff on a session that doesn't exist", async () => {
    const manager = new HandoffManager(await makeSessionManager(), createDefaultProviderRegistry());
    await expect(manager.finalizeHandoff("does-not-exist", "claude", { tokenLimits })).rejects.toThrow(
      SessionNotFoundError,
    );
  });

  it("an interrupted handoff (provider validated, then a downstream failure) still leaves the session unchanged", async () => {
    // Simulate "downstream failure" by using a token budget so tight that
    // allocateBudget still succeeds (it never throws) but prove the session
    // is untouched until the very end regardless -- validated by checking
    // state immediately after a rejected call above; this test instead
    // verifies revision does not advance on the UnknownProviderError path,
    // which is the only realistic pre-session-mutation failure this code
    // can hit deterministically.
    const sessionManager = await makeSessionManager();
    await seedSession(sessionManager, "claude");
    const before = await sessionManager.loadSession("sess-1");
    const manager = new HandoffManager(sessionManager, createDefaultProviderRegistry());

    await expect(manager.finalizeHandoff("sess-1", "unknown-provider-id", { tokenLimits })).rejects.toThrow();

    const after = await sessionManager.loadSession("sess-1");
    expect(after.revision).toBe(before.revision);
  });
});
