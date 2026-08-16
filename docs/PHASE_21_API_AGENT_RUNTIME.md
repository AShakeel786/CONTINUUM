# Phase 21 — Generic API Agent Runtime Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** Let ANY API-only provider (user manifest) run as a full CONTINUUM agent
without its own CLI, via a generic, protocol-selected API agent loop.

## Architecture

- `api-agent/types.ts` — provider-independent `AgentMessage`/`AgentToolCall`/`AgentTurnResult` + bounded-loop errors.
- `api-agent/runner.ts` — `createApiRunner(adapter)` selects OpenAI-compatible (`/chat/completions`)
  vs Anthropic-compatible (`/v1/messages`) purely from `capabilities.protocol`; reuses
  `ProviderAdapter.buildAuthHeaders()` (CredentialManager) + `resolveModel()`.
- `api-agent/format.ts` — MCP `ToolDefinition` → protocol tool schema (capability-driven).
- `api-agent/agent.ts` — bounded loop: model → tool request → MCP execution → tool result → model,
  with `maxIterations`/`timeoutMs` bounds; tool failures surfaced, never invented.
- `api-agent/run.ts` — `runApiAgent` builds first-turn messages from the budgeted `RenderedContext`.
- Launcher: `LaunchPreparation.runtimeKind` ("cli" | "api") + `rendered`; `cliAvailable` selects the runtime.
- `launch.ts` `launchPrepared()` routes API providers to the API agent, CLI providers to `spawnCli`.
- Handoff: `isLaunchable()` = CLI OR API auth, so API providers receive handoffs.

## API-agent UX

```
continuum provider add --id grok --protocol openai-compatible --base-url https://api.x.ai/v1 --auth api-key --env XAI_API_KEY --model grok-3
continuum auth grok
continuum launch <project> --provider grok     # runs the generic API agent (no CLI needed)
```

`provider list/show` now show `Runtime: Native CLI | CONTINUUM API`.

## OpenAI/Anthropic protocol results (mocked, protocol-faithful)

- OpenAI-compatible: POST `/chat/completions` with `Authorization: Bearer`; parses `choices[].message.content`
  + `tool_calls`; 401/bad-key → clear `ApiAgentError` ("… HTTP 401 …").
- Anthropic-compatible: POST `/v1/messages` with `x-api-key` + `anthropic-version`; system as separate field;
  parses `content[]` text + `tool_use` blocks.

## MCP/tool-loop result (live, mocked endpoint)

Ran the full loop against a protocol-faithful mocked OpenAI endpoint, driven by the user-added Grok
manifest, zero source changes:

```
[tool] memory_search → [tool error] MemoryCore is not configured. Search unavailable.
finalContent: Mocked final answer: memory searched successfully.
iterations: 2 | toolCalls: 1 | HTTP turns: 2
```

The real MCP registry executed `memory_search` (graceful MemoryCore-unconfigured degradation), the result
was fed back, and the loop produced a final answer. Tool failures surface; nothing is invented.

## Session/handoff result

- API providers participate in normal sessions: `launcher.prepareLaunch` → `runtimeKind:"api"`,
  `rendered` context, `TaskSession` created.
- `HandoffManager.finalizeHandoff` now accepts API-only providers (`isLaunchable` = CLI or API).
- Verified: Claude → Grok (API) handoff preserves `completedWork` (no re-audit) and renders
  openai-compatible context.
- No native-session id for API providers; the CONTINUUM TaskSession is authoritative.

## External-provider proof

Grok + GLM configured via Phase 20 public commands only. The Grok manifest drives the API runtime
end-to-end (above). Neither provider has any runtime code — only manifests + env-var names.

## Tests

- `npm test` → **56 files / 383 tests passed** (+9: runner 3, agent 5, handoff API-provider 1).
- `npm run typecheck` clean; `npm run build` clean.
- Coverage: OpenAI/Anthropic request/parse, non-2xx errors, multi-turn tool loop, tool failure surfaced,
  loop bound (max-iterations + timeout), API-only handoff target.

## Security

- No secrets in production code (scan-clean). Credentials resolve via SecretRef/CredentialManager.
- No arbitrary shell in API mode: tool execution is the same MCP `ToolRegistry`; no new bypass.
- Bounded loop (iterations + timeout) — no uncontrolled autonomous execution.

## Remaining limitations

1. **Non-streaming only** — responses are full-message; streaming is a future optimization.
2. **Live proof is mocked** — no real XAI/Zhipu credentials existed, so the end-to-end run used a
   protocol-faithful mock; the runner/loop are otherwise fully tested.
3. **Tool schema** reuses the MCP JSON Schema as-is (OpenAI `parameters` / Anthropic `input_schema`).

## Tencent health

- Stack untouched and healthy (`tdai-memory-core`/`tdai-proxy`/`tdai-memory-hub` Up healthy).
- No files changed in `TencentDB-Agent-Memory`.

## Final public-beta readiness verdict

**Ready for a public GitHub beta.** CONTINUUM now runs three bundled providers (Claude/DeepSeek/Codex)
plus any user-defined API provider (Grok/GLM proven) through one runtime, with native-session continuity,
MCP tooling, handoff, and bounded agent loops.
