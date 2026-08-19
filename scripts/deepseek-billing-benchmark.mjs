#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const BASELINE = { date: "2026-08-17", usd: 15.47, requests: 1934, cacheHitInputTokens: 467_000_000, cacheMissInputTokens: 2_820_000, inputTokens: 471_000_000, outputTokens: 1_540_000, proSpendShare: 0.95 };
const file = process.argv[2];
if (!file) {
  process.stdout.write(`${JSON.stringify({ baseline: BASELINE, usage: "node scripts/deepseek-billing-benchmark.mjs <billing-export.json>", note: "Only provider billing exports establish realized savings." }, null, 2)}\n`);
  process.exit(0);
}
const raw = JSON.parse(await readFile(file, "utf8"));
const rows = Array.isArray(raw) ? raw : raw.records ?? raw.data ?? [raw];
const number = (row, names) => names.reduce((v, n) => v ?? (row[n] !== undefined ? Number(row[n]) : undefined), undefined) ?? 0;
const actual = rows.reduce((a, r) => ({
  usd: a.usd + number(r, ["usd", "cost_usd", "amount_usd", "cost"]),
  requests: a.requests + number(r, ["requests", "request_count", "count"]),
  cacheHitInputTokens: a.cacheHitInputTokens + number(r, ["cache_hit_input_tokens", "cache_hit_tokens", "prompt_cache_hit_tokens"]),
  cacheMissInputTokens: a.cacheMissInputTokens + number(r, ["cache_miss_input_tokens", "cache_miss_tokens", "prompt_cache_miss_tokens"]),
  inputTokens: a.inputTokens + number(r, ["input_tokens", "total_input_tokens", "prompt_tokens"]),
  outputTokens: a.outputTokens + number(r, ["output_tokens", "completion_tokens"]),
}), { usd: 0, requests: 0, cacheHitInputTokens: 0, cacheMissInputTokens: 0, inputTokens: 0, outputTokens: 0 });
const ratio = (v, b) => b ? v / b : null;
process.stdout.write(`${JSON.stringify({ baseline: BASELINE, billingExport: actual, ratiosToBaseline: { usd: ratio(actual.usd, BASELINE.usd), requests: ratio(actual.requests, BASELINE.requests), cacheHitInputTokens: ratio(actual.cacheHitInputTokens, BASELINE.cacheHitInputTokens), cacheMissInputTokens: ratio(actual.cacheMissInputTokens, BASELINE.cacheMissInputTokens), inputTokens: ratio(actual.inputTokens, BASELINE.inputTokens), outputTokens: ratio(actual.outputTokens, BASELINE.outputTokens) }, attributionRule: "A lower internal context counter is not savings. Attribute only lower provider-billed model/API usage or documented Flash routing, and reconcile totals to this export." }, null, 2)}\n`);
