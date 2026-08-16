/**
 * DeepSeek provider profile.
 *
 * Two integration paths coexist in the real, currently-working Tencent
 * deployment, and this profile represents both without conflating them:
 *  - MemoryCore's own memory-processing calls (L1 extraction etc.) hit
 *    DeepSeek's native OpenAI-compatible API directly — `protocol`/`baseUrl`/
 *    `auth` below describe exactly that path.
 *  - Claude Code CLI sessions reach DeepSeek through the Tencent MemoryProxy,
 *    which forwards an Anthropic-shaped request unchanged to DeepSeek's own
 *    Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`) —
 *    the existing "impersonation trick." `cliLaunch` below models that
 *    routing, targeting the already-running default proxy
 *    (`deploy/global-images/start-proxy.sh`, port 8096) rather than any
 *    specific project's proxy — per-project routing is Project Registry
 *    territory, out of scope this phase.
 *
 * `sessionInit.headerAutoSelect.onMismatch: "bypass"` on the proxy side
 * (see CONTINUUM/docs/PHASE_2_SECURITY_STABILITY_REPORT.md §1a) is
 * preserved as-is — this profile only targets the proxy's existing base
 * URL, it does not touch or duplicate that setting.
 */

import { secretRef } from "../secrets.js";
import type { ProviderProfile } from "../types.js";

export const deepseekProfile: ProviderProfile = {
  id: "deepseek",
  displayName: "DeepSeek",
  protocol: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  auth: {
    kind: "api-key",
    secret: secretRef("DEEPSEEK_API_KEY"),
  },
  models: {
    // Matches the real, live default-proxy values (deploy/global-images/.env:
    // PROXY_UPSTREAM_MODEL / MEMORY_LLM_MODEL) as of Phase 2.1 verification.
    default: "deepseek-v4-pro",
    aliases: {
      flash: "deepseek-v4-flash",
    },
  },
  capabilities: {
    protocol: "openai-compatible",
    // DeepSeek emits unsigned `thinking` blocks that MemoryProxy's
    // anthropicHandler.ts strips (sanitizeThinkingBlocks) rather than
    // forwarding as Anthropic-shaped signed thinking — real, working
    // support, but with that caveat, hence "supported" not "extended".
    thinking: "supported",
    tools: true,
    promptCache: "openai-automatic",
    cliAvailable: true,
    notes:
      "CLI sessions are proxy-routed (Anthropic-impersonation trick); direct calls use DeepSeek's native " +
      "OpenAI-compatible API. Unsigned thinking blocks are stripped by MemoryProxy, not forwarded. " +
      "promptCache=openai-automatic means caching is server-side with no client directive to emit " +
      "(src/cache/directives.ts emits nothing for this mode); real hit/miss telemetry is still parseable " +
      "post-call from prompt_tokens_details.cached_tokens / cache_read_tokens (src/cache/telemetry.ts), " +
      "verified against MemoryProxy/src/credit-reporter.ts's existing, in-production field mapping.",
  },
  environment: {
    owns: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  },
  cliLaunch: {
    kind: "proxy-routed",
    executable: "claude",
    configDirName: ".claude-tencent",
    proxyBaseUrl: "http://127.0.0.1:8096",
    proxyPathSuffix: "/claude-code/default",
    // The proxy-local admin/user key (e.g. from deploy/global-images/.admin-key),
    // NOT DeepSeek's own API key — the proxy holds DeepSeek's real upstream
    // key server-side and injects it itself (see R-8 migration).
    proxyUserKeySecret: secretRef("CONTINUUM_TENCENT_PROXY_USER_KEY"),
    clearEnvVars: [],
    // The proxy-routed path launches the `claude` binary (Claude Code), so its
    // real native-session semantics are Claude's own `--resume <id>` flag.
    nativeResume: {
      supported: true,
      resume: { kind: "flag", flag: "--resume" },
      sessionStore: { rootDir: "~/.claude-tencent/projects", extension: ".jsonl", idFrom: "basename" },
    },
  },
};
