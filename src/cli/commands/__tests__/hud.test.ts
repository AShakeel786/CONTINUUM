import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildHudData, buildProviderIdentity, formatHud, formatProviderIdentity, formatTerminalTitle, printHud, type HudData } from "../hud.js";
import type { LaunchPreparation } from "../../../launcher/types.js";
import type { Launcher } from "../../../launcher/launcher.js";
import type { ProviderRegistry } from "../../../providers/registry.js";
import type { ProjectRecord } from "../../../registry/types.js";
import type { TaskSession } from "../../../session/types.js";

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    name: "PASSCARS",
    path: "/Users/home/Downloads/test-repo",
    aliases: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function session(overrides: Partial<TaskSession> = {}): TaskSession {
  return {
    schemaVersion: 1,
    sessionId: "s1",
    revision: 1,
    mode: "project",
    workingDirectory: "/Users/home/Downloads/test-repo",
    activeProvider: { providerId: "claude", model: "claude-sonnet" },
    taskGoal: "do the thing",
    status: "active",
    completedWork: [],
    remainingWork: [],
    importantDecisions: [],
    relevantFiles: [],
    recentToolActivity: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function prep(overrides: Partial<LaunchPreparation> = {}): LaunchPreparation {
  return {
    plan: {
      providerId: "claude",
      model: "claude-sonnet",
      executable: "claude",
      args: [],
      env: {},
      clearEnvVars: [],
      workingDir: "/Users/home/Downloads/test-repo",
      bypassPermissions: false,
    },
    project: project(),
    providerRef: { providerId: "claude", model: "claude-sonnet" },
    session: session(),
    stale: false,
    staleReasons: [],
    memoryCoreAvailable: true,
    runtimeKind: "cli",
    rendered: { protocol: "anthropic-messages", system: "", userPrefix: "", cacheDirectives: [] },
    contextWindowTokens: 200_000,
    contextTokensUsed: 36_000,
    route: "direct",
    modelDecision: { automatic: true, reason: "provider default" },
    ...overrides,
  };
}

function fakeProviders(displayName = "Claude"): ProviderRegistry {
  return {
    has: () => true,
    get: () => ({ profile: { displayName } }) as ReturnType<ProviderRegistry["get"]>,
  } as unknown as ProviderRegistry;
}

function fakeProvidersWithPromo(displayName: string, promo: { until: string; note: string }): ProviderRegistry {
  return {
    has: () => true,
    get: () => ({ profile: { displayName, promo } }) as ReturnType<ProviderRegistry["get"]>,
  } as unknown as ProviderRegistry;
}

function fakeLauncher(authenticated: readonly { providerId: string; model: string }[]): Launcher {
  return { listAuthenticatedProviders: async () => authenticated } as unknown as Launcher;
}

describe("buildHudData", () => {
  it("formats a terminal title that survives native Claude redraws", () => {
    expect(formatTerminalTitle({ workspace: "General", providerLabel: "DeepSeek", model: "deepseek-v4-flash", contextUsed: 1200, contextMax: 200000, handoff: "ready", memoryOff: false, bypass: false, peak: { multiplier: 2, endsAt: new Date("2026-08-19T10:00:00Z") } })).toContain("DeepSeek | deepseek-v4-flash | ctx 1k/200k | handoff ready | PEAK 2×");
  });
  it("flags FULL ACCESS in the terminal title when bypass is active", () => {
    const title = formatTerminalTitle({ workspace: "General", providerLabel: "Codex", model: "gpt-5.6-sol", contextUsed: 1200, contextMax: 200000, handoff: "ready", memoryOff: false, bypass: true, peak: undefined });
    expect(title).toContain("FULL ACCESS");
  });
  it("resolves a registered project workspace by name", async () => {
    const data = await buildHudData(prep(), { launcher: fakeLauncher([{ providerId: "claude", model: "x" }, { providerId: "deepseek", model: "y" }]), providers: fakeProviders() });
    expect(data.workspace).toBe("PASSCARS");
    expect(data.providerLabel).toBe("Claude");
    expect(data.handoff).toBe("ready"); // another authenticated provider exists
  });

  it("resolves general-mode workspace to 'General'", async () => {
    const data = await buildHudData(
      prep({ session: session({ mode: "general" }) }),
      { launcher: fakeLauncher([]), providers: fakeProviders() },
    );
    expect(data.workspace).toBe("General");
    expect(data.handoff).toBe("off"); // no other authenticated agent
  });

  it("resolves current-directory workspace to a ~-relative path", async () => {
    const home = homedir();
    const path = `${home}/Downloads/test-repo`;
    const data = await buildHudData(
      prep({ session: session({ mode: "current-directory" }), project: project({ path }) }),
      { launcher: fakeLauncher([]), providers: fakeProviders("DeepSeek") },
    );
    expect(data.workspace).toBe("~/Downloads/test-repo");
    expect(data.providerLabel).toBe("DeepSeek");
  });

  it("reports handoff 'pending' when the session is mid-handoff, regardless of other agents", async () => {
    const data = await buildHudData(
      prep({ session: session({ status: "handoff-pending" }) }),
      { launcher: fakeLauncher([{ providerId: "deepseek", model: "y" }]), providers: fakeProviders() },
    );
    expect(data.handoff).toBe("pending");
  });

  it("degrades handoff to 'off' when listAuthenticatedProviders throws", async () => {
    const launcher = { listAuthenticatedProviders: async () => { throw new Error("boom"); } } as unknown as Launcher;
    const data = await buildHudData(prep(), { launcher, providers: fakeProviders() });
    expect(data.handoff).toBe("off");
  });

  it("surfaces memoryOff only when MemoryCore is unavailable", async () => {
    const on = await buildHudData(prep({ memoryCoreAvailable: true }), { launcher: fakeLauncher([]), providers: fakeProviders() });
    const off = await buildHudData(prep({ memoryCoreAvailable: false }), { launcher: fakeLauncher([]), providers: fakeProviders() });
    expect(on.memoryOff).toBe(false);
    expect(off.memoryOff).toBe(true);
  });

  it("passes through bypassPermissions and context token counts unchanged", async () => {
    const data = await buildHudData(
      prep({ plan: { ...prep().plan, bypassPermissions: true }, contextTokensUsed: 18_000, contextWindowTokens: 100_000 }),
      { launcher: fakeLauncher([]), providers: fakeProviders() },
    );
    expect(data.bypass).toBe(true);
    expect(data.contextUsed).toBe(18_000);
    expect(data.contextMax).toBe(100_000);
  });

  it("surfaces an active promo label and omits it otherwise", async () => {
    const active = await buildHudData(
      prep({ providerRef: { providerId: "ox-alpha", model: "ox-alpha-free" } }),
      { launcher: fakeLauncher([]), providers: fakeProvidersWithPromo("Ox Alpha Free", { until: "2099-01-01T00:00:00Z", note: "FREE" }) },
    );
    expect(active.promo).toBeDefined();
    expect(active.promo).toContain("FREE");
    const plain = await buildHudData(prep(), { launcher: fakeLauncher([]), providers: fakeProviders() });
    expect(plain.promo).toBeUndefined();
  });
});

describe("formatHud", () => {
  const base: HudData = {
    workspace: "PASSCARS",
    providerLabel: "Claude",
    contextUsed: 36_000,
    contextMax: 200_000,
    handoff: "ready",
    memoryOff: false,
    bypass: true,
  };

  it("renders the full line at a wide width", () => {
    expect(formatHud(base, 200)).toBe("CONTINUUM | PASSCARS | FULL ACCESS | Claude | ctx 36k/200k | handoff ready");
  });

  it("omits bypass when off and memory when on (nothing notable)", () => {
    const line = formatHud({ ...base, bypass: false }, 200);
    expect(line).not.toContain("FULL ACCESS");
    expect(line).not.toContain("memory");
  });

  it("shows 'memory off' when MemoryCore is unavailable", () => {
    const line = formatHud({ ...base, memoryOff: true }, 200);
    expect(line).toContain("memory off");
  });

  it("omits the context field entirely when token counts are unavailable", () => {
    const { contextUsed, contextMax, ...rest } = base;
    const line = formatHud(rest as HudData, 200);
    expect(line).not.toContain("ctx");
  });

  it("compacts context to a percentage before dropping fields, on a medium-narrow terminal", () => {
    const line = formatHud(base, 60);
    expect(line).toContain("ctx 18%");
  });

  it("drops lowest-priority fields first but always keeps CONTINUUM, workspace, and FULL ACCESS", () => {
    const line = formatHud(base, 35);
    expect(line.startsWith("CONTINUUM | PASSCARS")).toBe(true);
    expect(line).toContain("FULL ACCESS");
    expect(line).not.toContain("handoff");
  });

  it("shows an active promo segment at wide widths and drops it first on narrow ones", () => {
    const promoBase: HudData = { ...base, promo: "FREE (until Aug 27)" };
    const wide = formatHud(promoBase, 200);
    expect(wide).toContain("FREE (until Aug 27)");
    const narrow = formatHud(promoBase, 60);
    // Promo is the lowest-priority segment: gone before provider/context/handoff.
    expect(narrow).not.toContain("FREE");
  });

  it("never exceeds the given width, hard-truncating with an ellipsis as a last resort", () => {
    const line = formatHud(base, 12);
    expect(line.length).toBeLessThanOrEqual(12);
    expect(line.endsWith("…")).toBe(true);
  });

  it("is stable and self-consistent across the full width range (never throws, never exceeds width)", () => {
    for (let cols = 1; cols <= 120; cols++) {
      const line = formatHud(base, cols);
      expect(line.length).toBeLessThanOrEqual(cols);
    }
  });
});

describe("printHud", () => {
  it("prints one line via out() and never throws even if data-gathering fails", async () => {
    const lines: string[] = [];
    const launcher = { listAuthenticatedProviders: async () => { throw new Error("boom"); } } as unknown as Launcher;
    await printHud((s) => lines.push(s), prep(), { launcher, providers: fakeProviders() }, 200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CONTINUUM");
  });

  it("is silent (no throw) if buildHudData itself rejects unexpectedly", async () => {
    const providers = { has: () => { throw new Error("registry exploded"); } } as unknown as ProviderRegistry;
    const lines: string[] = [];
    await expect(printHud((s) => lines.push(s), prep(), { launcher: fakeLauncher([]), providers }, 200)).resolves.toBeUndefined();
  });
});

describe("provider identity promo line", () => {
  function oxProviders(promo?: { until: string; note: string }): ProviderRegistry {
    return {
      has: () => true,
      get: () => ({
        profile: { displayName: "Ox Alpha Free", baseUrl: "https://openrouter.ai/zen/go/v1", promo },
        resolveCliLaunch: () => ({ kind: "native", executable: "n/a" }),
      }) as unknown as ReturnType<ProviderRegistry["get"]>,
    } as unknown as ProviderRegistry;
  }

  it("shows Promo for an API-runtime provider with an active promo", () => {
    const identity = buildProviderIdentity(
      prep({ providerRef: { providerId: "ox-alpha", model: "ox-alpha-free" }, runtimeKind: "api" }),
      oxProviders({ until: "2099-01-01T00:00:00Z", note: "FREE" }),
    );
    expect(identity.provider).toBe("Ox Alpha Free");
    expect(identity.model).toBe("ox-alpha-free");
    expect(identity.route).toContain("openrouter.ai");
    const text = formatProviderIdentity(identity);
    expect(text).toContain("Promo: FREE");
  });

  it("omits the Promo line without a promo (and for expired promos)", () => {
    const none = formatProviderIdentity(
      buildProviderIdentity(prep({ providerRef: { providerId: "ox-alpha", model: "ox-alpha-free" }, runtimeKind: "api" }), oxProviders()),
    );
    expect(none).not.toContain("Promo:");
    const expired = formatProviderIdentity(
      buildProviderIdentity(
        prep({ providerRef: { providerId: "ox-alpha", model: "ox-alpha-free" }, runtimeKind: "api" }),
        oxProviders({ until: "2000-01-01T00:00:00Z", note: "FREE" }),
      ),
    );
    expect(expired).not.toContain("Promo:");
  });

  it("shows Claude Code as the client and route for the redirected harness", () => {
    const providers = {
      has: () => true,
      get: () => ({
        profile: { displayName: "Ox Alpha Free", baseUrl: "https://openrouter.ai/api/v1" },
        resolveCliLaunch: () => ({ kind: "redirected", executable: "claude", baseUrl: "https://openrouter.ai/api" }),
      }) as unknown as ReturnType<ProviderRegistry["get"]>,
    } as unknown as ProviderRegistry;
    const identity = buildProviderIdentity(
      prep({ providerRef: { providerId: "ox-alpha", model: "stealth/ox-alpha" }, runtimeKind: "cli" }),
      providers,
    );
    expect(identity.client).toBe("Claude Code");
    expect(identity.route).toBe("Claude Code → openrouter.ai");
  });
});
