#!/usr/bin/env node
// Claude Code invokes this supported statusLine command with session JSON on
// stdin. Keep it fast, deterministic, secret-free, and independent of the
// Claude binary's private internals.
import fs from "node:fs";

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}

const provider = process.env.CONTINUUM_STATUS_PROVIDER || "DeepSeek";
const model = process.env.CONTINUUM_STATUS_MODEL || "deepseek-v4-flash";
const handoff = process.env.CONTINUUM_STATUS_HANDOFF || "ready";
// Optional context fields the launcher sets on redirected/proxy launches.
const workspace = process.env.CONTINUUM_STATUS_WORKSPACE;
const route = process.env.CONTINUUM_STATUS_ROUTE;
const access = process.env.CONTINUUM_STATUS_ACCESS; // "full" when full-access is enabled
const tz = process.env.CONTINUUM_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const windows = [[1, 4], [6, 10]];
// CONTINUUM_STATUS_NOW is intentionally an opt-in test hook; production
// statusline renders use the real clock.
const now = process.env.CONTINUUM_STATUS_NOW ? new Date(process.env.CONTINUUM_STATUS_NOW) : new Date();
const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
const peakWindow = windows.find(([start, end]) => hour >= start && hour < end);

function localTime(date) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}
function localRange(startHour, endHour, dayOffset = 0) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, startHour));
  const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, endHour));
  return `${localTime(d)}–${localTime(e)}`;
}
function nextPeak() {
  for (let day = 0; day <= 2; day++) for (const [start, end] of windows) {
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, start));
    if (candidate > now) return { candidate, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, end)), range: localRange(start, end, day) };
  }
  return undefined;
}

// Keep the complete local schedule available in the HUD. The dates are
// derived from UTC windows at render time, so the display follows the
// user's timezone and DST rules instead of embedding Toronto-specific hours.
const dailyPeak = `Peak windows (local): ${localRange(1, 4)}; ${localRange(6, 10)}`;

const context = input.context_window ?? {};
const size = Number(context.context_window_size ?? context.contextWindowSize ?? 200000);
const current = Number(context.current_usage?.input_tokens ?? context.input_tokens ?? 0);
const pct = Number(context.used_percentage);
const used = current > 0 ? current : (Number.isFinite(pct) ? Math.round(size * pct / 100) : 0);
const compact = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const ctx = `ctx ${compact(used)}/${compact(size)}`;
let pricing;
if (peakWindow) {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(peakWindow[1]);
  pricing = `⚠ PEAK 2× until ${localTime(end)}`;
} else {
  const next = nextPeak();
  pricing = next ? `OFF-PEAK | next peak ${localTime(next.candidate)}–${localTime(next.end)} | ${dailyPeak}` : `OFF-PEAK | ${dailyPeak}`;
}
// Order mirrors the launch HUD (CONTINUUM | workspace | FULL ACCESS | provider
// | model | route | pricing | ctx | handoff) so the persistent footer and the
// HUD agree, on every platform — the CLI's shell drops nothing we emit.
const parts = ["CONTINUUM"];
if (workspace) parts.push(workspace);
if (access === "full") parts.push("FULL ACCESS");
parts.push(provider, model);
if (route) parts.push(route);
parts.push(pricing, ctx, `handoff ${handoff}`);
process.stdout.write(parts.join(" | "));
