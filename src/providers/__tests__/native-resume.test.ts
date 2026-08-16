import { afterEach, describe, expect, it } from "vitest";
import { createProviderAdapter } from "../adapter.js";
import { claudeProfile } from "../profiles/claude.js";
import { deepseekProfile } from "../profiles/deepseek.js";
import { codexProfile } from "../profiles/codex.js";

const ORIGINAL = process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
  else process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = ORIGINAL;
});

describe("native resume args (data-driven, no provider switch)", () => {
  it("Claude builds --resume <id> when a resume id is requested", () => {
    const plan = createProviderAdapter(claudeProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "claude-123" });
    expect(plan.args).toEqual(["--resume", "claude-123"]);
  });

  it("Codex builds resume <id> (subcommand) when a resume id is requested", () => {
    const plan = createProviderAdapter(codexProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "codex-123" });
    expect(plan.args).toEqual(["resume", "codex-123"]);
  });

  it("DeepSeek proxy-routed path builds --resume <id> (Claude Code semantics) and still injects proxy env", () => {
    process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = "sk-proxy-test";
    const plan = createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "ds-123" });
    expect(plan.args).toEqual(["--resume", "ds-123"]);
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8096/claude-code/default");
  });

  it("builds empty args when no resume id is requested (fresh native session)", () => {
    expect(createProviderAdapter(claudeProfile).buildCliLaunchPlan({ workingDir: "/x" }).args).toEqual([]);
    expect(createProviderAdapter(codexProfile).buildCliLaunchPlan({ workingDir: "/x" }).args).toEqual([]);
    process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = "sk-proxy-test";
    expect(createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x" }).args).toEqual([]);
  });

  it("declares nativeResume in every profile (data, serializable, no functions)", () => {
    for (const profile of [claudeProfile, deepseekProfile, codexProfile]) {
      const nr = profile.cliLaunch.nativeResume;
      expect(nr).toBeDefined();
      expect(nr!.supported).toBe(true);
      if (nr!.supported) {
        expect(typeof nr!.sessionStore.rootDir).toBe("string");
        expect(typeof nr!.sessionStore.extension).toBe("string");
        // Profile remains JSON-serializable (no functions — the resume shapes are data).
        expect(JSON.stringify(nr)).toBeTruthy();
      }
    }
  });
});
