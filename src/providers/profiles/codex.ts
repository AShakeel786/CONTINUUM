/**
 * Codex provider profile — OpenAI's Codex CLI (native coding-agent CLI).
 *
 * Integration stance, matching the existing native-Claude path exactly:
 *   - CLI launch (`buildCliLaunchPlan`) is `cliLaunch.kind: "native"` — the
 *     launcher injects NO credential and sets NO model; Codex authenticates
 *     itself via its own native session (`~/.codex/auth.json`, ChatGPT OAuth
 *     tokens on this machine) and its own config (`~/.codex/config.toml`).
 *   - `auth.kind: "cli-session"` is the honest statement of that: CONTINUUM
 *     holds no Codex secret and can never copy/store its OAuth credentials.
 *     `buildAuthHeaders()` therefore refuses to fabricate a header.
 *
 * The default model and aliases below were read live from the installed
 * `codex debug models` catalog (0.147.0) — `gpt-5.6-sol` is the priority-1
 * default; `terra`/`luna`/`mini` are other slugs in that catalog. The native
 * launch does NOT pass a model flag (Codex uses its own config default), so
 * these values are session/display metadata, never a launch override.
 */

import type { ProviderProfile } from "../types.js";

export const codexProfile: ProviderProfile = {
  id: "codex",
  displayName: "Codex",
  protocol: "openai-compatible",
  baseUrl: "https://api.openai.com",
  auth: {
    kind: "cli-session",
    note:
      "Codex authenticates via its own native CLI session (~/.codex/auth.json). " +
      "CONTINUUM never holds, copies, or stores the OAuth tokens.",
  },
  models: {
    default: "gpt-5.6-sol",
    aliases: {
      terra: "gpt-5.6-terra",
      luna: "gpt-5.6-luna",
      mini: "gpt-5.4-mini",
    },
  },
  capabilities: {
    protocol: "openai-compatible",
    // Codex exposes reasoning effort levels (low→ultra) and auto task
    // delegation — genuinely extended, not just a "supported" toggle.
    thinking: "extended",
    tools: true,
    promptCache: "openai-automatic",
    cliAvailable: true,
    notes:
      "Native Codex CLI session (not API-key proxied). Default model gpt-5.6-sol read from the " +
      "installed `codex debug models` catalog (0.147.0). promptCache=openai-automatic means caching " +
      "is server-side with no client directive to emit (same as DeepSeek's direct path).",
  },
  environment: {
    owns: ["OPENAI_API_KEY", "CODEX_HOME", "CODEX_ACCESS_TOKEN"],
  },
  cliLaunch: {
    kind: "native",
    executable: "codex",
    // No configDirName: Codex uses its native ~/.codex home, not CLAUDE_CONFIG_DIR.
    clearEnvVars: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    nativeResume: {
      supported: true,
      resume: { kind: "subcommand", subcommand: "resume" },
      // Canonical id read directly from the JSONL `session_meta` record's
      // `payload.session_id` (proven live), with last-uuid as fallback.
      sessionStore: {
        rootDir: "~/.codex/sessions",
        extension: ".jsonl",
        idFrom: "session-meta",
        metaRecordType: "session_meta",
        metaPayloadField: "session_id",
      },
      // No sessionIdFlag: Codex generates its own session UUID (no --session-id),
      // so its id is still discovered via the store scan, not set deterministically.
    },
    mcp: { supported: true, serverName: "continuum" },
  },
};
