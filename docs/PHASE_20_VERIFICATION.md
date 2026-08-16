# Phase 20 — Universal Provider Extension Framework Verification

**Date:** 2026-08-16
**Branch:** master (CONTINUUM)
**Scope:** Let users add API/CLI providers via secret-free manifests — no source edits.

## Manifest architecture

- `providers/manifest.ts` — `ProviderManifest` schema (`schemaVersion: 1`) + `validateManifest`
  + `manifestToProfile`/`manifestToAuthMetadata`/`manifestToCliAuthCapability` converters.
- `providers/manifest-store.ts` — `~/.continuum/providers/<id>.json` load/save/delete (plain JSON).
- `providers/presets.ts` — Claude/DeepSeek/Codex declared as the SAME manifest shape.
- `providers/profiles/*.ts` — now derive from the bundled manifests (single source of truth).
- `providers/index.ts` — `createProviderRegistry(userManifests)` = bundled + user.
- `auth/provider-auth/*` — `createProviderAuthMetadata(userManifests)` + `createCliAuthManager(userManifests)`.
- Runtime wiring (`buildContext`, `buildLauncherContext`, `project`) loads user manifests.

Manifests are **secret-free**: they store only the env-var *name* (`XAI_API_KEY`), never a key.
Credentials stay in `CredentialManager` (via the existing `continuum auth <provider>` masked prompt).

## Add-provider UX

```bash
continuum provider add --id grok --protocol openai-compatible \
  --base-url https://api.x.ai/v1 --auth api-key --env XAI_API_KEY --model grok-3
continuum provider list      # bundled + user-defined
continuum provider show grok # full manifest
continuum provider remove grok
continuum provider validate manifest.json
```

API flow needs only name, base URL, auth kind + env-var name, and model. CLI flow adds
`--cli <exe>` (executable + login/logout args). No YAML/.env/source editing.

## API/CLI flows

- **OpenAI-compatible API** (Grok/GLM): `protocol openai-compatible`, `auth api-key` → Bearer
  header for direct calls; `cliAvailable:false` (direct-API only, no interactive launch).
- **Anthropic-compatible API**: `protocol anthropic-messages`, `auth api-key` → `x-api-key`.
- **Native CLI**: `auth cli-session` + `--cli <exe>` → generic CLI auth (exit-code detection),
  reuse of existing CLI-auth/session/MCP machinery.
- **API + CLI**: a manifest can declare both API auth and a CLI block.

## Grok/GLM proof (zero source changes)

Both added purely through `continuum provider add`:

| Provider | Protocol | Auth | Model | cliAvailable |
|---|---|---|---|---|
| grok | openai-compatible | api-key (XAI_API_KEY) | grok-3 | false |
| glm | openai-compatible | api-key (ZHIPU_API_KEY) | glm-4-plus | false |

Verified live: `provider list` shows both; `providers` lists auth state; `project add --provider grok`
works; `launch` fails gracefully (`grok has no stored API key`); direct-API `buildAuthHeaders()`
→ `Authorization: Bearer …`; `remove`/re-add round-trips; `validate` rejects a secret-bearing
manifest and bundled `remove` is refused. Neither provider is hardcoded anywhere in runtime code.

## Compatibility limits

- **API-only providers (Grok/GLM) are direct-API only** — `cliAvailable:false`, so they are
  correctly excluded from CLI launch/handoff (which require a coding-agent CLI). This is
  capability-driven, not a special case.
- **CLI user providers** use the generic exit-code auth adapter (no custom status parser);
  a provider needing a custom parser would require a small adapter (a future extension point).

## Tests

- `npm test` → **54 files / 374 tests passed** (+11: manifest 8, manifest-store 3).
- `npm run typecheck` clean; `npm run build` clean.
- Coverage: manifest validation (schema/id/URL/env-var/secret rejection), profile+auth-metadata
  conversion, Grok/GLM registry round-trip, store save/load/delete/skip-invalid.

## Security

- Manifests store env-var names only; `validateManifest` rejects inline secrets.
- No secret in logs/config/manifests/git (scan-clean). Credentials remain in `CredentialManager`.

## Tencent health

- Stack untouched and healthy (`tdai-memory-core`/`tdai-proxy`/`tdai-memory-hub` Up healthy).
- No files changed in `TencentDB-Agent-Memory`.

## Verdict

CONTINUUM is now genuinely provider-neutral: adding Grok/GLM required **zero source changes**.
Combined with Phases 15–19, this satisfies the "add a provider without editing source" goal.
