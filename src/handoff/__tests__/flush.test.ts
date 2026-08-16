import { afterEach, describe, expect, it, vi } from "vitest";
import { flushHandoff } from "../flush.js";
import { secretRef } from "../../providers/secrets.js";
import { SESSION_SCHEMA_VERSION, type TaskSession } from "../../session/types.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function fixtureSession(overrides: Partial<TaskSession> = {}): TaskSession {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: "sess-1",
    revision: 1,
    projectId: "proj-1",
    workingDirectory: "C:\\fake\\project",
    activeProvider: { providerId: "claude", model: "claude-sonnet-5" },
    taskGoal: "Fix the deploy script",
    status: "active",
    completedWork: [{ id: "w1", description: "Diagnosed the root cause", recordedAt: "2026-01-01T00:00:00.000Z" }],
    remainingWork: [{ id: "w2", description: "Write the fix", recordedAt: "2026-01-01T00:00:00.000Z" }],
    importantDecisions: [{ id: "d1", decision: "Use node instead of python3", recordedAt: "2026-01-01T00:00:00.000Z" }],
    relevantFiles: [{ path: "deploy/start-all.sh", recordedAt: "2026-01-01T00:00:00.000Z" }],
    recentToolActivity: [{ id: "t1", tool: "Bash", summary: "ran tests", recordedAt: "2026-01-01T00:00:00.000Z" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const memoryCoreCfg = {
  baseUrl: "http://127.0.0.1:8420",
  serviceToken: secretRef("TEST_FLUSH_TOKEN"),
  serviceId: "default",
  teamId: "team-x",
  userId: "user-x",
  agentId: "agent-x",
};

describe("flushHandoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_FLUSH_TOKEN;
  });

  it("builds a package with all session summaries rendered (not a raw transcript)", async () => {
    const pkg = await flushHandoff(fixtureSession(), {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "deepseek", model: "deepseek-v4-pro" },
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
    });

    expect(pkg.objective).toBe("Fix the deploy script");
    expect(pkg.completedWork).toEqual(["Diagnosed the root cause"]);
    expect(pkg.remainingWork).toEqual(["Write the fix"]);
    expect(pkg.decisions).toEqual(["Use node instead of python3"]);
    expect(pkg.relevantFiles).toEqual(["deploy/start-all.sh"]);
    expect(pkg.recentToolActivity).toEqual(["[Bash] ran tests"]);
    expect(pkg.tencentMemoryFreshness).toBe("none");
  });

  it("always includes a resume-instructions block in the stable section, class 'instructions'", async () => {
    const pkg = await flushHandoff(fixtureSession(), {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "claude", model: "claude-sonnet-5" },
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
    });
    const resumeBlock = pkg.contextEnvelope.stable.blocks.find((b) => b.id === "handoff:resume-instructions");
    expect(resumeBlock).toBeDefined();
    expect(resumeBlock?.class).toBe("instructions");
    expect(resumeBlock?.content).toContain("Fix the deploy script");
    expect(resumeBlock?.content).toContain("Diagnosed the root cause");
  });

  it("the resume-instructions block survives even an extremely tight token budget (critical instructions never dropped)", async () => {
    const pkg = await flushHandoff(fixtureSession(), {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "claude", model: "claude-sonnet-5" },
      tokenLimits: { contextWindow: 5, reservedOutput: 0 }, // absurdly tight
    });
    const resumeBlock = pkg.contextEnvelope.stable.blocks.find((b) => b.id === "handoff:resume-instructions");
    expect(resumeBlock).toBeDefined();
    expect(pkg.tokenBudget.criticalContentOverBudget).toBe(true); // flagged honestly, not silently truncated
  });

  it("uses a fresh MemoryCore fetch when provided and reachable", async () => {
    process.env.TEST_FLUSH_TOKEN = "sk-mem-flush-fixture";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/v3/core/read")) return jsonResponse({ code: 0, data: { content: "Fresh persona content." } });
        if (u.endsWith("/v3/scenario/ls")) return jsonResponse({ code: 0, data: { entries: [] } });
        if (u.endsWith("/v3/atomic/search")) return jsonResponse({ code: 0, data: { items: [] } });
        throw new Error(`unexpected URL: ${u}`);
      }),
    );

    const pkg = await flushHandoff(fixtureSession(), {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "claude", model: "claude-sonnet-5" },
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
      memoryCore: { config: memoryCoreCfg, query: "deploy script" },
    });

    expect(pkg.tencentMemoryFreshness).toBe("fresh");
    expect(pkg.contextEnvelope.stable.blocks.some((b) => b.content.includes("Fresh persona content."))).toBe(true);
  });

  it("falls back to the session's stored ContextEnvelope snapshot when MemoryCore times out -- never blocks or fails the handoff", async () => {
    process.env.TEST_FLUSH_TOKEN = "sk-mem-flush-fixture";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})), // never resolves -- simulates a hung Gateway
    );

    const storedEnvelope = {
      stable: {
        blocks: [
          {
            id: "memorycore:persona:l3",
            class: "persona" as const,
            content: "Stale but usable persona snapshot.",
            priority: 10,
            provenance: { source: "memorycore-gateway:/v3/core/read", fetchedAt: "2025-12-01T00:00:00.000Z" },
          },
        ],
      },
      dynamic: { blocks: [] },
      metadata: { sessionKey: "sess-1", query: "old query", assembledAt: "2025-12-01T00:00:00.000Z" },
    };

    const pkg = await flushHandoff(fixtureSession({ contextEnvelope: storedEnvelope }), {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "claude", model: "claude-sonnet-5" },
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
      memoryCore: { config: memoryCoreCfg, query: "deploy script", timeoutMs: 50 },
    });

    expect(pkg.tencentMemoryFreshness).toBe("snapshot");
    expect(pkg.contextEnvelope.stable.blocks.some((b) => b.content.includes("Stale but usable persona snapshot."))).toBe(true);
  }, 10000);

  it("works with no MemoryCore config and no stored snapshot at all -- session-only handoff", async () => {
    const pkg = await flushHandoff(fixtureSession(), {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "deepseek", model: "deepseek-v4-pro" },
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
    });
    expect(pkg.tencentMemoryFreshness).toBe("none");
    // Still produces a usable package -- the resume block alone.
    expect(pkg.contextEnvelope.stable.blocks).toHaveLength(1);
  });

  it("detects and surfaces stale git state when provided", async () => {
    const session = fixtureSession({
      git: {
        repoRoot: "/repo",
        branch: "main",
        headSha: "a".repeat(40),
        dirty: false,
        changedFileSummary: "clean",
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const pkg = await flushHandoff(session, {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "claude", model: "claude-sonnet-5" },
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
      currentGit: {
        repoRoot: "/repo",
        branch: "main",
        headSha: "b".repeat(40), // HEAD moved -- someone else committed
        dirty: false,
        changedFileSummary: "clean",
        capturedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    expect(pkg.staleness.stale).toBe(true);
    const resumeBlock = pkg.contextEnvelope.stable.blocks.find((b) => b.id === "handoff:resume-instructions");
    expect(resumeBlock?.content).toContain("STALE STATE WARNING");
  });

  it("does not flag staleness when no currentGit is provided to compare against", async () => {
    const pkg = await flushHandoff(fixtureSession(), {
      sourceProvider: { providerId: "claude", model: "claude-sonnet-5" },
      targetProvider: { providerId: "claude", model: "claude-sonnet-5" },
      tokenLimits: { contextWindow: 100_000, reservedOutput: 4096 },
    });
    expect(pkg.staleness.stale).toBe(false);
  });
});
