# DeepSeek cost-control audit — Aug 17 baseline

Baseline: **$15.47 USD**, **1,934 requests**, approximately **467M cache-hit input tokens**, **2.82M cache-miss input tokens**, **471M total input tokens**, and **1.54M output tokens**. V4 Pro represented about 95% of spend.

The official USD rates used by the estimator are Flash `$0.007/$0.22/$0.66` and Pro `$0.022/$0.66/$1.98` per million cache-hit/cache-miss/output tokens off-peak; the configured peak multiplier is 2×.

## Proven native path and controls

`Launcher.prepareLaunch` resolves the DeepSeek provider and model, then `ProviderAdapter.buildCliLaunchPlan` produces `claude` plus `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN`, and model-tier environment variables. `spawnCli` starts that unchanged binary with inherited stdio. CONTINUUM does not construct or intercept Claude Code's internal Messages API payload.

Claude Code 2.1.235 exposes supported `--session-id`, `--resume`, `--fork-session`, `--autocompact`, and `--append-system-prompt`. Interactive `/compact` cannot be invoked externally in an already-running inherited-stdio process. Session transcripts are durable JSONL under the profile's configured `~/.claude-*/projects` store. Assistant records contain usage fields including input, cache creation/read, and output tokens; this is a supported-on-disk, read-only observation point, not request interception.

## Root causes

1. `contextTokensUsed` was the Token Manager count for only CONTINUUM's launch envelope. It never measured Claude's resumed transcript, so pruning/repo-map/tool-output optimizers could reduce injected context without affecting the native conversation Claude resent.
2. Same-provider resume always supplied `--resume <native id>`, preserving the entire Claude conversation. No native rollover policy existed.
3. DeepSeek's provider default was V4 Pro. Claude tier mappings also sent primary Sonnet/default work to Pro, explaining Pro's spend dominance.
4. Peak notifications asked for the next transition. When launched during peak, the next transition was off-peak, so the notification layer ignored it. Checks ran at launch only; resume omitted the check; inherited-stdio meant the HUD did not update while running.
5. The schedule arithmetic itself used UTC safely and local formatting used `Intl`, but warnings did not state the multiplier/end and no runtime crossing monitor existed.

## Fix

Routine DeepSeek work defaults to V4 Flash. Explicit `--model pro` and project/session model preferences are preserved and logged as explicit decisions; all implicit Claude tiers (including Opus, Sonnet, Haiku, and subagents) map to Flash. Native JSONL usage is monitored without patching Claude. A running process is warned when context crosses the configured threshold and is never killed. On the next normal resume, automatic mode compares future cached-context cost against a compact fresh-session handoff including its cache-miss penalty. Token-threshold mode is available via `CONTINUUM_ROLLOVER_MODE=tokens`; `CONTINUUM_ROLLOVER_TOKENS` configures the threshold. Old transcripts remain intact. Handoffs and old/new native ids are stored under the unchanged logical session lineage.

Peak launch detection now handles already-active windows, resume checks pricing, the HUD includes `PEAK <multiplier>×→<local end>`, and a runtime monitor keeps a terminal-title indicator for the peak period and announces boundary crossings.

Telemetry in `~/.continuum/cost-telemetry.jsonl` is explicitly labelled estimated. `continuum cost [session]` summarizes it. Use `node scripts/deepseek-billing-benchmark.mjs <billing-export.json>` to compare a future provider export with Aug 17. Internal counters alone never establish savings.

## Limitation

Claude's transcript usage is observed after responses are written, not before DeepSeek receives them. CONTINUUM cannot safely force `/compact` or replace an active inherited-stdio session. Automatic rollover therefore occurs at a resume boundary. Billing exports remain authoritative. The official DeepSeek pricing page currently confirms separate off-peak and peak rates: peak is 2× off-peak, with windows 01:00–04:00 UTC and 06:00–10:00 UTC.
