import { afterEach, describe, expect, it } from "vitest";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PricingAwarenessService } from "../service.js";
import { suggestHandoffOnPeakEvent } from "../handoff-suggestion.js";
import { createDefaultPricingSchedules } from "../schedules/index.js";
import { SessionManager } from "../../session/manager.js";
import { FileSessionStore } from "../../session/store.js";
import { createDefaultProviderRegistry } from "../../providers/index.js";
import { HandoffManager } from "../../handoff/manager.js";

let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "continuum-pricing-service-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fsPromises.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeService(dir: string) {
  const sessionManager = new SessionManager(new FileSessionStore(dir));
  const registry = createDefaultProviderRegistry();
  const service = new PricingAwarenessService(sessionManager, registry, createDefaultPricingSchedules());
  return { sessionManager, registry, service };
}

async function seedDeepSeekSession(sessionManager: SessionManager) {
  await sessionManager.createSession({
    sessionId: "sess-1",
    projectId: "proj-1",
    workingDirectory: "C:\\fake",
    activeProvider: { providerId: "deepseek", model: "deepseek-v4-pro" },
    taskGoal: "Ship the feature",
  });
}

describe("PricingAwarenessService — persisted pricing-window state", () => {
  it("persists currentTier and nextTransition onto the session after a check", async () => {
    const dir = await makeTmpDir();
    const { sessionManager, service } = await makeService(dir);
    await seedDeepSeekSession(sessionManager);

    const { session } = await service.check("sess-1", new Date("2026-08-16T02:00:00.000Z"));

    expect(session.pricingAwareness?.providerId).toBe("deepseek");
    expect(session.pricingAwareness?.currentTier).toBe("peak");
    expect(session.pricingAwareness?.nextTransition?.toTier).toBe("off-peak");
  });

  it("is a no-op (no error, no state written) for a provider with no pricing schedule", async () => {
    const dir = await makeTmpDir();
    const { sessionManager, service } = await makeService(dir);
    await sessionManager.createSession({
      sessionId: "sess-1",
      projectId: "proj-1",
      workingDirectory: "C:\\fake",
      activeProvider: { providerId: "claude", model: "claude-sonnet-5" },
      taskGoal: "Ship the feature",
    });

    const { session, events } = await service.check("sess-1", new Date("2026-08-16T02:00:00.000Z"));
    expect(events).toEqual([]);
    expect(session.pricingAwareness).toBeUndefined();
  });

  it("diagnostics() reports the current tier and next transition in a human-readable line", async () => {
    const dir = await makeTmpDir();
    const { sessionManager, service } = await makeService(dir);
    await seedDeepSeekSession(sessionManager);
    const now = new Date("2026-08-16T02:00:00.000Z");
    const { session } = await service.check("sess-1", now);

    const diagnostics = service.diagnostics(session, now, "UTC");
    expect(diagnostics).toContain("DeepSeek");
    expect(diagnostics).toContain("currently peak");
    expect(diagnostics).toContain("off-peak");
  });
});

describe("PricingAwarenessService — no duplicate notification after restart", () => {
  it("does not re-fire a pre-peak notification when a fresh service/session-manager instance re-checks before the transition", async () => {
    const dir = await makeTmpDir();
    const first = await makeService(dir);
    await seedDeepSeekSession(first.sessionManager);

    const preTime = new Date("2026-08-16T00:50:00.000Z"); // 10 min before 01:00 peak
    const firstCheck = await first.service.check("sess-1", preTime);
    expect(firstCheck.events.map((e) => e.kind)).toEqual(["pre-peak"]);

    // Simulate a full process restart: brand-new SessionManager/PricingAwarenessService
    // instances, sharing only the on-disk directory.
    const second = await makeService(dir);
    const secondCheckTime = new Date("2026-08-16T00:55:00.000Z"); // still before the transition
    const secondCheck = await second.service.check("sess-1", secondCheckTime);
    expect(secondCheck.events).toEqual([]); // no duplicate
  });

  it("fires peak-started exactly once even across a restart landing after the transition", async () => {
    const dir = await makeTmpDir();
    const first = await makeService(dir);
    await seedDeepSeekSession(first.sessionManager);
    await first.service.check("sess-1", new Date("2026-08-16T01:00:00.000Z")); // fires peak-started

    const second = await makeService(dir);
    const secondCheck = await second.service.check("sess-1", new Date("2026-08-16T01:05:00.000Z"));
    expect(secondCheck.events).toEqual([]);
  });
});

describe("suggestHandoffOnPeakEvent — user-selectable handoff, never automatic", () => {
  it("surfaces the peak-started message plus available providers, without calling finalizeHandoff", async () => {
    const dir = await makeTmpDir();
    const { sessionManager, registry, service } = await makeService(dir);
    await seedDeepSeekSession(sessionManager);
    const handoffManager = new HandoffManager(sessionManager, registry);

    const { events } = await service.check("sess-1", new Date("2026-08-16T01:00:00.000Z"));
    const peakStarted = events.find((e) => e.kind === "peak-started");
    expect(peakStarted).toBeDefined();

    const suggestion = suggestHandoffOnPeakEvent(peakStarted!, handoffManager);
    expect(suggestion?.message).toContain("hand it off");
    expect(suggestion?.availableProviders.map((p) => p.providerId).sort()).toEqual([
      "antigravity",
      "claude",
      "codex",
      "deepseek",
      "gemini-free",
      "groq-free",
      "openrouter-free",
      "ox-alpha",
    ]);

    // Provider was NOT changed -- suggesting is not the same as switching.
    const session = await sessionManager.loadSession("sess-1");
    expect(session.activeProvider.providerId).toBe("deepseek");
  });

  it("returns undefined for a non-peak-related event kind", async () => {
    const dir = await makeTmpDir();
    const { sessionManager, registry } = await makeService(dir);
    const handoffManager = new HandoffManager(sessionManager, registry);
    const fakeEvent = {
      kind: "some-other-kind" as never,
      providerId: "deepseek",
      transitionAt: new Date().toISOString(),
      toTier: "peak" as const,
      message: "irrelevant",
    };
    expect(suggestHandoffOnPeakEvent(fakeEvent, handoffManager)).toBeUndefined();
  });

  it("a user who accepts the suggestion can still complete a real handoff through the normal Phase 5 workflow", async () => {
    const dir = await makeTmpDir();
    const { sessionManager, registry, service } = await makeService(dir);
    await seedDeepSeekSession(sessionManager);
    const handoffManager = new HandoffManager(sessionManager, registry);

    const { events } = await service.check("sess-1", new Date("2026-08-16T01:00:00.000Z"));
    const peakStarted = events.find((e) => e.kind === "peak-started")!;
    const suggestion = suggestHandoffOnPeakEvent(peakStarted, handoffManager)!;
    const chosen = suggestion.availableProviders.find((p) => p.providerId !== "deepseek")!;

    const result = await handoffManager.finalizeHandoff("sess-1", chosen.providerId, {
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
    });
    expect(result.session.activeProvider.providerId).toBe("claude");
  });
});
