import { describe, expect, it, vi } from "vitest";
import { needsNativeSessionCapture } from "../launch.js";
import type { Launcher } from "../../../launcher/launcher.js";
import type { LaunchPreparation } from "../../../launcher/types.js";

function prep(overrides: Partial<LaunchPreparation> = {}): LaunchPreparation {
  return {
    session: { sessionId: "logical-session" },
    providerRef: { providerId: "codex", model: "gpt-5.6-sol" },
    ...overrides,
  } as LaunchPreparation;
}

describe("native session capture guard", () => {
  it("captures a new non-deterministic provider session", () => {
    const launcher = { supportsDeterministicSessionId: vi.fn(() => false) } as unknown as Launcher;
    expect(needsNativeSessionCapture(launcher, prep())).toBe(true);
  });

  it("never store-scans an existing native resume", () => {
    const launcher = { supportsDeterministicSessionId: vi.fn(() => false) } as unknown as Launcher;
    expect(
      needsNativeSessionCapture(
        launcher,
        prep({ nativeResume: { providerId: "codex", nativeSessionId: "native-session" } }),
      ),
    ).toBe(false);
  });

  it("does not capture deterministic providers or launches without a logical session", () => {
    const deterministic = { supportsDeterministicSessionId: vi.fn(() => true) } as unknown as Launcher;
    expect(needsNativeSessionCapture(deterministic, prep())).toBe(false);

    const nonDeterministic = { supportsDeterministicSessionId: vi.fn(() => false) } as unknown as Launcher;
    expect(needsNativeSessionCapture(nonDeterministic, prep({ session: undefined }))).toBe(false);
  });
});
