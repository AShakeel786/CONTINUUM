/**
 * Claude provider profile — native Anthropic Messages API.
 *
 * Two integration paths coexist, matching the real, currently-working
 * Tencent launcher (`windows/launch-tencent-claude.ps1`, native-Claude
 * branch):
 *  - Direct API calls (`buildAuthHeaders`) use `ANTHROPIC_API_KEY`, for a
 *    future native LLMRunner-style caller.
 *  - CLI launch (`buildCliLaunchPlan`) is `cliLaunch.kind: "native"` — no
 *    key is injected at all; the CLI relies on its own already-authenticated
 *    session, and CONTINUUM only clears vars a *different* provider's launch
 *    might have left behind (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`,
 *    which the DeepSeek proxy-routed path sets) so a stale env var can't
 *    silently redirect a native Claude session through the proxy.
 */

import { secretRef } from "../secrets.js";
import type { ProviderProfile } from "../types.js";

export const claudeProfile: ProviderProfile = {
  id: "claude",
  displayName: "Claude",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  auth: {
    kind: "api-key",
    secret: secretRef("ANTHROPIC_API_KEY"),
  },
  models: {
    default: "claude-sonnet-5",
    aliases: {
      fast: "claude-haiku-4-5-20251001",
      opus: "claude-opus-5",
      fable: "claude-fable-5",
    },
  },
  capabilities: {
    protocol: "anthropic-messages",
    thinking: "extended",
    tools: true,
    promptCache: "anthropic-explicit",
    cliAvailable: true,
    // Publicly documented Anthropic default context window as of this
    // phase. Not verified against a live API call for this exact model —
    // confirm per-model before relying on this for production budgeting
    // decisions; Token Manager (src/token/) treats it as an input, not a
    // hardcoded assumption, so correcting it later requires no code change.
    contextWindowTokens: 200_000,
    notes:
      "Extended thinking and native Anthropic explicit cache_control breakpoints are supported by the " +
      "protocol. Phase 4 (src/cache/) emits a single ephemeral cache_control breakpoint at the end of " +
      "the stable prefix; TTL selection (5m vs 1h) is not yet implemented.",
  },
  environment: {
    owns: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
  },
  cliLaunch: {
    kind: "native",
    executable: "claude",
    configDirName: ".claude-anthropic",
    clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  },
};
