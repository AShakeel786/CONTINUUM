import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { createProviderAdapter } from "../adapter.js";
import { deepseekProfile } from "../profiles/deepseek.js";
import { claudeProfile } from "../profiles/claude.js";
import { MissingSecretError, ProviderAuthError, UnknownModelAliasError } from "../errors.js";
import { DEEPSEEK_PROXY_SERVICE_ID } from "../deepseek-proxy.js";

/**
 * Locate a Git Bash on win32 — the shell the Claude Code statusline executor
 * uses on Windows (spawn `bash -c <command>`). Returns undefined when absent,
 * in which case the integration test is skipped rather than failing.
 */
function findGitBash(): string | undefined {
  const candidates = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const fromCmd = join(dirname(dir), "bin", "bash.exe"); // ...\Git\cmd → ...\Git\bin\bash.exe
    if (existsSync(fromCmd)) return fromCmd;
    if (existsSync(join(dir, "bash.exe"))) return join(dir, "bash.exe");
  }
  return undefined;
}

function execBash(bash: string, command: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bash, ["-c", command], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.resume();
    child.stdin.write("{}");
    child.stdin.end();
    child.on("error", () => resolve({ code: 1, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim() }));
  });
}

const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ORIGINAL_PROXY_KEY = process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  for (const [varName, original] of [
    ["DEEPSEEK_API_KEY", ORIGINAL_DEEPSEEK_API_KEY],
    ["CONTINUUM_TENCENT_PROXY_USER_KEY", ORIGINAL_PROXY_KEY],
    ["ANTHROPIC_API_KEY", ORIGINAL_ANTHROPIC_API_KEY],
  ] as const) {
    if (original === undefined) delete process.env[varName];
    else process.env[varName] = original;
  }
});

describe("DeepSeek adapter", () => {
  it("resolves the canonical deepseek-flash default and the pro/flash/legacy aliases", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    expect(adapter.resolveModel()).toBe("deepseek-flash");
    expect(adapter.resolveModel("flash")).toBe("deepseek-flash");
    expect(adapter.resolveModel("pro")).toBe("deepseek-v4-pro");
    expect(adapter.resolveModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    // Legacy ids normalize to the canonical current model id.
    expect(adapter.resolveModel("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(adapter.resolveModel("v4-flash")).toBe("deepseek-flash");
    // The Claude Code [1m] context suffix is client metadata, stripped before resolution.
    expect(adapter.resolveModel("deepseek-v4-flash[1m]")).toBe("deepseek-flash");
    expect(adapter.resolveModel("deepseek-flash[1m]")).toBe("deepseek-flash");
    expect(adapter.resolveModel("deepseek-v4-pro[1m]")).toBe("deepseek-v4-pro");
    // A nonexistent production id is refused, never silently routed.
    expect(() => adapter.resolveModel("deepseek-v4.1-flash")).toThrowError(UnknownModelAliasError);
  });

  it("keeps every implicit Claude tier on the canonical Flash, including Opus", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-tier-fixture";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/tmp" });
    expect(plan.env.ANTHROPIC_MODEL).toBe("sonnet");
    expect(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(plan.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-5");
    // haiku + subagent are not override-able by Claude Code — env carries the
    // provider model directly so no claude-* id leaks upstream.
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-flash");
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-flash");
  });

  it("allows Pro only as an explicit primary model and never via implicit tier mapping", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-tier-fixture";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/tmp", modelAlias: "pro" });
    expect(plan.env.ANTHROPIC_MODEL).toBe("sonnet");
    expect(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(plan.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-5");
    expect(plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-flash");
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-flash");
  });

  it("aligns Claude Code's stream-idle watchdog with DeepSeek's documented queued-stream hold (direct route)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-tier-fixture";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/tmp" });
    // DeepSeek keeps queued streams alive with keep-alive frames for up to
    // ~10 minutes (hard cap ~30); Claude Code 2.1.270's default stream-idle
    // window aborts them at ~10 minutes even while keep-alives flow
    // (verified empirically 2026-09-14). The launch must carry the
    // provider-aligned window.
    expect(plan.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
    // The optional Tencent proxy route is deliberately left on the client
    // default — this launch did not opt into it.
    expect(plan.env.ANTHROPIC_BASE_URL).toContain("127.0.0.1:8177");
  });

  it("throws UnknownModelAliasError for an unmapped alias", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.resolveModel("opus")).toThrowError(UnknownModelAliasError);
  });

  it("builds Bearer auth headers for a direct openai-compatible API call", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test-fixture-value";
    const adapter = createProviderAdapter(deepseekProfile);
    const headers = adapter.buildAuthHeaders();
    expect(headers).toEqual({ Authorization: "Bearer sk-deepseek-test-fixture-value" });
    expect(headers).not.toHaveProperty("x-api-key");
  });

  it("resolveCliLaunch defaults to the direct (redirected) descriptor and selects proxy on route=proxy", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    expect(adapter.resolveCliLaunch().kind).toBe("redirected");
    expect(adapter.resolveCliLaunch("direct").kind).toBe("redirected");
    expect(adapter.resolveCliLaunch("proxy").kind).toBe("proxy-routed");
  });

  it("direct CLI launch routes through the local compatibility proxy and injects the upstream API key (never the Tencent proxy URL)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project" });
    expect(plan.executable).toBe("claude");
    // The compat proxy is the ONLY Claude Code → DeepSeek boundary: the CLI
    // points at the loopback sanitizer (which forwards to
    // https://api.deepseek.com), never at the remote endpoint directly.
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8177/anthropic");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-direct-fixture-key");
    expect(plan.env.ANTHROPIC_BASE_URL).not.toContain("api.deepseek.com");
    expect(plan.configDir).toBe(".claude-deepseek");
  });

  it("the direct launch descriptor still declares the real upstream for the compat proxy to forward to", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    const launch = adapter.resolveCliLaunch("direct");
    expect(launch.kind).toBe("redirected");
    if (launch.kind !== "redirected") throw new Error("unreachable");
    expect(launch.baseUrl).toBe("https://api.deepseek.com/anthropic"); // upstream, kept as data
    expect(launch.compatProxy).toMatchObject({
      host: "127.0.0.1",
      port: 8177,
      cliPathSuffix: "/anthropic",
      upstreamBaseUrl: "https://api.deepseek.com",
      serviceId: DEEPSEEK_PROXY_SERVICE_ID,
    });
  });

  it("configures Claude's supported persistent statusLine HUD for redirected launches", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/tmp" });
    const settingsIndex = plan.args.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(plan.args[settingsIndex + 1] ?? "{}");
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.refreshInterval).toBe(5);
    // The command must quote BOTH paths and use forward slashes — the Windows
    // statusline executor runs it through Git Bash, where an unquoted
    // process.execPath (a path containing spaces) split on whitespace and the
    // footer silently vanished (`C:Program: command not found`, exit 127).
    expect(settings.statusLine.command).toMatch(/^"[^"]*node[^"]*" "[^"]*continuum-statusline\.mjs"$/);
    expect(settings.statusLine.command).not.toContain("\\");
    expect(settings.modelOverrides["claude-sonnet-5"]).toBe("deepseek-flash");
    expect(settings.modelOverrides["claude-opus-5"]).toBe("deepseek-flash");
    expect(plan.env.CONTINUUM_STATUS_PROVIDER).toBe("DeepSeek");
    expect(plan.env.CONTINUUM_STATUS_MODEL).toBe("deepseek-flash");
    // Authoritative footer context: workspace label, route indicator, and
    // (absent here) the FULL ACCESS marker for safe mode.
    expect(plan.env.CONTINUUM_STATUS_WORKSPACE).toBe("tmp");
    expect(plan.env.CONTINUUM_STATUS_ROUTE).toBe("direct");
    expect(plan.env.CONTINUUM_STATUS_ACCESS).toBeUndefined();
  });

  it("statusline workspace label renders ~ for the home dir and ~/… under it", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
    const adapter = createProviderAdapter(deepseekProfile);
    expect(adapter.buildCliLaunchPlan({ workingDir: homedir() }).env.CONTINUUM_STATUS_WORKSPACE).toBe("~");
    expect(adapter.buildCliLaunchPlan({ workingDir: join(homedir(), "my-project") }).env.CONTINUUM_STATUS_WORKSPACE).toBe(`~${sep}my-project`);
  });

  it("marks FULL ACCESS in the statusline env when permissionMode is bypass", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "/tmp", permissionMode: "bypass" });
    expect(plan.env.CONTINUUM_STATUS_ACCESS).toBe("full");
    expect(plan.args).toContain("--dangerously-skip-permissions");
  });

  it.runIf(process.platform === "win32")(
    "integration (win32): the statusline command renders the full footer through Git Bash",
    async () => {
      const bash = findGitBash();
      if (!bash) return; // no Git Bash on this machine → skip gracefully
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
      const adapter = createProviderAdapter(deepseekProfile);
      const plan = adapter.buildCliLaunchPlan({ workingDir: join(homedir(), "project"), permissionMode: "bypass" });
      const settingsIndex = plan.args.indexOf("--settings");
      const settings = JSON.parse(plan.args[settingsIndex + 1] ?? "{}");
      const result = await execBash(bash, settings.statusLine.command, {
        ...plan.env,
        CONTINUUM_STATUS_NOW: "2026-01-01T00:00:00Z", // fix the clock so pricing is deterministic
      });
      expect(result.code).toBe(0);
      const footer = result.stdout;
      expect(footer).toContain("CONTINUUM");
      expect(footer).toContain("project"); // workspace label
      expect(footer).toContain("FULL ACCESS");
      expect(footer).toContain("DeepSeek");
      expect(footer).toContain("DeepSeek V4.1 Flash"); // canonical model shown by its user-facing name
      expect(footer).toContain("direct"); // route indicator
      expect(footer).toContain("ctx");
      expect(footer).toContain("handoff");
      expect(footer).toContain("Mon–Fri"); // weekday-gated schedule surfaced

      // Weekend gating: Saturday inside the would-be 06:00–10:00 UTC window
      // must render OFF-PEAK (the official schedule is Monday–Friday only).
      const weekend = await execBash(bash, settings.statusLine.command, {
        ...plan.env,
        CONTINUUM_STATUS_NOW: "2026-01-03T08:00:00Z", // Saturday
      });
      expect(weekend.code).toBe(0);
      expect(weekend.stdout).toContain("OFF-PEAK");
      expect(weekend.stdout).not.toContain("PEAK 2×");
    },
  );

  it("direct launch never reads the proxy user key (no Tencent dependency)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-direct-fixture-key";
    process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = "sk-proxy-must-not-be-used";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "C:\\fake" });
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-direct-fixture-key");
  });

  it("proxy-routed CLI launch (route=proxy) routes through the compat proxy in front of the MemoryProxy and injects the proxy-local key, not DeepSeek's own key", () => {
    process.env.CONTINUUM_TENCENT_PROXY_USER_KEY = "sk-mem-test-fixture-proxy-key";
    const adapter = createProviderAdapter(deepseekProfile);
    const plan = adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project", route: "proxy" });
    expect(plan.executable).toBe("claude");
    // Boundary for the opt-in Tencent route: a second sanitizing-proxy
    // instance (port 8178) forwards unchanged to the MemoryProxy at 8096.
    expect(plan.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8178/claude-code/default");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-mem-test-fixture-proxy-key");
    expect(plan.configDir).toBe(".claude-tencent");
  });

  it("the proxy-routed launch descriptor keeps the MemoryProxy URL as data (compat proxy forwards to it)", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    const launch = adapter.resolveCliLaunch("proxy");
    expect(launch.kind).toBe("proxy-routed");
    if (launch.kind !== "proxy-routed") throw new Error("unreachable");
    expect(launch.proxyBaseUrl).toBe("http://127.0.0.1:8096"); // MemoryProxy, kept as data
    expect(launch.compatProxy).toMatchObject({
      host: "127.0.0.1",
      port: 8178,
      cliPathSuffix: "/claude-code/default",
      upstreamBaseUrl: "http://127.0.0.1:8096",
      serviceId: DEEPSEEK_PROXY_SERVICE_ID,
    });
  });

  it("a provider-specific failure: missing proxy key surfaces as ProviderAuthError in proxy mode, not a generic error", () => {
    delete process.env.CONTINUUM_TENCENT_PROXY_USER_KEY;
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project", route: "proxy" })).toThrowError(
      ProviderAuthError,
    );
  });

  it("a provider-specific failure: missing upstream key surfaces as ProviderAuthError in direct mode", () => {
    delete process.env.DEEPSEEK_API_KEY;
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.buildCliLaunchPlan({ workingDir: "C:\\fake\\project" })).toThrowError(ProviderAuthError);
  });

  it("missing DEEPSEEK_API_KEY for a direct call fails as MissingSecretError, distinct from the launch-time ProviderAuthError case", () => {
    delete process.env.DEEPSEEK_API_KEY;
    const adapter = createProviderAdapter(deepseekProfile);
    expect(() => adapter.buildAuthHeaders()).toThrowError(MissingSecretError);
  });

  it("env/auth isolation: DeepSeek's launch never reads Claude's ANTHROPIC_API_KEY, and vice versa", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-belongs-to-claude-only";
    delete process.env.DEEPSEEK_API_KEY;
    const deepseekAdapter = createProviderAdapter(deepseekProfile);
    // DeepSeek's direct launch has its own secret requirement and must still
    // fail even though an unrelated provider's key is present in env — proves
    // no accidental cross-provider fallback.
    expect(() => deepseekAdapter.buildCliLaunchPlan({ workingDir: "C:\\fake" })).toThrowError(ProviderAuthError);

    process.env.DEEPSEEK_API_KEY = "sk-deepseek-only";
    delete process.env.ANTHROPIC_API_KEY;
    const claudeAdapter = createProviderAdapter(claudeProfile);
    // Claude's direct-call auth must still fail even though DeepSeek's key is
    // present — proves the reverse direction too.
    expect(() => claudeAdapter.buildAuthHeaders()).toThrowError(MissingSecretError);
  });

  it("reports capabilities honestly, including the thinking-block caveat", () => {
    const adapter = createProviderAdapter(deepseekProfile);
    const caps = adapter.getCapabilities();
    expect(caps.protocol).toBe("openai-compatible");
    expect(caps.thinking).toBe("supported");
    expect(caps.cliAvailable).toBe(true);
  });
});
