import { afterEach, describe, expect, it } from "vitest";
import { createProviderAdapter } from "../adapter.js";
import { claudeProfile } from "../profiles/claude.js";
import { deepseekProfile } from "../profiles/deepseek.js";
import { codexProfile } from "../profiles/codex.js";

const ORIGINAL = process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
const ORIGINAL_DS = process.env.DEEPSEEK_API_KEY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
  else process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = ORIGINAL;
  if (ORIGINAL_DS === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = ORIGINAL_DS;
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

  it("DeepSeek direct path builds --resume <id> (Claude Code semantics) and injects the upstream key env", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-api-test";
    const plan = createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "ds-123" });
    expect(plan.args.slice(0, 2)).toEqual(["--resume", "ds-123"]);
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
  });

  it("DeepSeek proxy path (route=proxy) builds --resume <id> and injects proxy env", () => {
    process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = "sk-proxy-test";
    const plan = createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "ds-123", route: "proxy" });
    expect(plan.args.slice(0, 2)).toEqual(["--resume", "ds-123"]);
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8096/claude-code/default");
  });

  it("builds empty args when no resume id is requested (fresh native session)", () => {
    expect(createProviderAdapter(claudeProfile).buildCliLaunchPlan({ workingDir: "/x" }).args).toEqual([]);
    expect(createProviderAdapter(codexProfile).buildCliLaunchPlan({ workingDir: "/x" }).args).toEqual([]);
    process.env.DEEPSEEK_API_KEY = "sk-ds-api-test";
    const deepseekArgs = createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x" }).args;
    expect(deepseekArgs[0]).toBe("--settings");
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

  it("deterministic session-id: Claude/DeepSeek set --session-id, Codex does not", () => {
    const claude = createProviderAdapter(claudeProfile).buildCliLaunchPlan({ workingDir: "/x", setSessionId: "sess-1" });
    expect(claude.args).toEqual(["--session-id", "sess-1"]);

    process.env.DEEPSEEK_API_KEY = "sk-ds-api-test";
    const ds = createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x", setSessionId: "sess-2" });
    expect(ds.args.slice(0, 2)).toEqual(["--session-id", "sess-2"]);

    // Codex declares no sessionIdFlag → a setSessionId is ignored (store-scan fallback).
    const codex = createProviderAdapter(codexProfile).buildCliLaunchPlan({ workingDir: "/x", setSessionId: "sess-3" });
    expect(codex.args).toEqual([]);
  });

  it("resume id takes precedence over a set session id", () => {
    const plan = createProviderAdapter(claudeProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "resume-1", setSessionId: "fresh-1" });
    expect(plan.args).toEqual(["--resume", "resume-1"]);
  });
});
