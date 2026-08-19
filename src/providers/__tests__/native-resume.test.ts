import { afterEach, describe, expect, it } from "vitest";
import { createProviderAdapter } from "../adapter.js";
import { claudeProfile } from "../profiles/claude.js";
import { deepseekProfile } from "../profiles/deepseek.js";
import { codexProfile } from "../profiles/codex.js";
import { antigravityProfile } from "../profiles/antigravity.js";

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
    // `-m <model>` precedes the `resume` subcommand (codex clap ordering — top-level options
    // must come before the subcommand).
    expect(plan.args).toEqual(["-m", "gpt-5.6-sol", "resume", "codex-123"]);
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
    // Codex/agy carry no session-id flag, but a native `-m/--model` is always
    // emitted so an explicit (or default) model reaches the CLI on fresh launch.
    expect(createProviderAdapter(codexProfile).buildCliLaunchPlan({ workingDir: "/x" }).args).toEqual(["-m", "gpt-5.6-sol"]);
    process.env.DEEPSEEK_API_KEY = "sk-ds-api-test";
    const deepseekArgs = createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x" }).args;
    expect(deepseekArgs[0]).toBe("--settings");
  });

  it("declares nativeResume in every profile (data, serializable, no functions)", () => {
    for (const profile of [claudeProfile, deepseekProfile, codexProfile, antigravityProfile]) {
      const nr = profile.cliLaunch.nativeResume;
      expect(nr).toBeDefined();
      expect(nr!.supported).toBe(true);
      if (nr!.supported) {
        if (nr!.sessionStore.kind === "files") {
          expect(typeof nr!.sessionStore.rootDir).toBe("string");
          expect(typeof nr!.sessionStore.extension).toBe("string");
        } else {
          expect(typeof nr!.sessionStore.dbPath).toBe("string");
          expect(typeof nr!.sessionStore.idColumn).toBe("string");
          expect(typeof nr!.sessionStore.mtimeColumn).toBe("string");
        }
        // Profile remains JSON-serializable (no functions — the resume shapes are data).
        expect(JSON.stringify(nr)).toBeTruthy();
      }
    }
  });

  it("Antigravity builds --conversation <id> and never sets a deterministic session id", () => {
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "antigravity-123" });
    // `--model <id>` always precedes resume/session args.
    expect(plan.args.slice(2, 4)).toEqual(["--conversation", "antigravity-123"]);
    // agy declares no sessionIdFlag → a setSessionId is ignored (store-scan fallback),
    // but the default `--model` is still emitted on fresh launch.
    const fresh = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({ workingDir: "/x", setSessionId: "sess-1" });
    expect(fresh.args).toEqual(["--model", "gemini-3.7-flash-high"]);
  });

  it("deterministic session-id: Claude/DeepSeek set --session-id, Codex does not", () => {
    const claude = createProviderAdapter(claudeProfile).buildCliLaunchPlan({ workingDir: "/x", setSessionId: "sess-1" });
    expect(claude.args).toEqual(["--session-id", "sess-1"]);

    process.env.DEEPSEEK_API_KEY = "sk-ds-api-test";
    const ds = createProviderAdapter(deepseekProfile).buildCliLaunchPlan({ workingDir: "/x", setSessionId: "sess-2" });
    expect(ds.args.slice(0, 2)).toEqual(["--session-id", "sess-2"]);

    // Codex declares no sessionIdFlag → a setSessionId is ignored (store-scan fallback),
    // but the default `-m` is still emitted.
    const codex = createProviderAdapter(codexProfile).buildCliLaunchPlan({ workingDir: "/x", setSessionId: "sess-3" });
    expect(codex.args).toEqual(["-m", "gpt-5.6-sol"]);
  });

  it("resume id takes precedence over a set session id", () => {
    const plan = createProviderAdapter(claudeProfile).buildCliLaunchPlan({ workingDir: "/x", resumeNativeSessionId: "resume-1", setSessionId: "fresh-1" });
    expect(plan.args).toEqual(["--resume", "resume-1"]);
  });
});
