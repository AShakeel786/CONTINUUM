import { describe, expect, it } from "vitest";
import { createProviderAdapter } from "../adapter.js";
import { antigravityProfile } from "../profiles/antigravity.js";
import { ProviderConfigError } from "../errors.js";

describe("antigravity provider adapter", () => {
  it("is native, cli-session, cli-available, and holds no secret", () => {
    const adapter = createProviderAdapter(antigravityProfile);
    expect(adapter.profile.id).toBe("antigravity");
    expect(adapter.profile.auth.kind).toBe("cli-session");
    expect(adapter.profile.capabilities.cliAvailable).toBe(true);
    expect(adapter.profile.cliLaunch.kind).toBe("native");
    expect(adapter.profile.cliLaunch.executable).toBe("agy");
    // No credential is stored or injected — native launch env is empty.
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/x" });
    expect(plan.env).toEqual({});
    expect(plan.clearEnvVars).toEqual([]);
  });

  it("resolves default + alias models (from the live `agy models` list)", () => {
    const adapter = createProviderAdapter(antigravityProfile);
    expect(adapter.resolveModel()).toBe("gemini-3.7-flash-high");
    expect(adapter.resolveModel("low")).toBe("gemini-3.7-flash-low");
    expect(adapter.resolveModel("pro")).toBe("gemini-3.1-pro-high");
  });

  it("buildAuthHeaders throws (cli-session cannot make a direct API call)", () => {
    const adapter = createProviderAdapter(antigravityProfile);
    expect(() => adapter.buildAuthHeaders()).toThrowError(ProviderConfigError);
  });

  it("declares a sqlite session store for --conversation resume", () => {
    const nr = antigravityProfile.cliLaunch.nativeResume;
    expect(nr).toBeDefined();
    expect(nr!.supported).toBe(true);
    if (nr!.supported) {
      expect(nr!.resume).toEqual({ kind: "flag", flag: "--conversation" });
      expect(nr!.sessionStore.kind).toBe("sqlite");
      expect(nr!.sessionIdFlag).toBeUndefined();
    }
  });
});
