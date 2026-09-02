/**
 * Direct-API local-model performance benchmark. Measures the SAME fixed
 * prompt / output cap through four paths and reports where CONTINUUM adds
 * overhead:
 *
 *   A. direct mlx_lm.generate            (python, no server)
 *   B. direct HTTP /v1/chat/completions  (mlx_lm.server, no CONTINUUM)
 *   C. CONTINUUM Direct-API, chat-only   (no coding tools, no project context)
 *   D. CONTINUUM Direct-API, full harness (project context + tool schemas)
 *
 * Runs each path N times after 1 warm-up and reports the median. Requires the
 * managed local service to be reachable (start it first, e.g. via a launch or
 * `node scripts/ornith-perf-benchmark.mjs --start`).
 *
 * Usage:
 *   node scripts/ornith-perf-benchmark.mjs [--runs 3] [--max-tokens 256]
 *       [--provider local-ornith15] [--project passcars] [--prompt "..."]
 */

import { spawnSync } from "node:child_process";

const DIST = new URL("../dist/", import.meta.url).pathname;
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const RUNS = Number(arg("runs", "3"));
const MAX_TOKENS = Number(arg("max-tokens", "256"));
const PROVIDER = arg("provider", "local-ornith15");
const PROJECT = arg("project", "passcars");
const PROMPT = arg("prompt", "Write a short function `slugify(s)` in TypeScript and briefly explain it.");
const TEMP = 0.0;

const { createDefaultProviderRegistry } = await import(`${DIST}providers/index.js`);
const { resolveLocalServiceDescriptor } = await import(`${DIST}local-service/descriptor.js`);
const { estimateTokens } = await import(`${DIST}token/tokenizer.js`);
const { toOpenAiTools } = await import(`${DIST}api-agent/format.js`);
const { buildToolRegistry } = await import(`${DIST}mcp/build.js`);
const { runApiAgent } = await import(`${DIST}api-agent/run.js`);
const { buildLauncherContext } = await import(`${DIST}cli/commands/launcher-context.js`);
const { createPrompt } = await import(`${DIST}auth/prompt.js`);

const reg = createDefaultProviderRegistry();
const profile = reg.get(PROVIDER).profile;
const adapter = reg.get(PROVIDER);
const d = resolveLocalServiceDescriptor(profile);
const endpoint = `http://${d.host}:${d.port}`;
const model = profile.models.default;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
const fmt = (n, p = 1) => (n === undefined || Number.isNaN(n) ? "—" : n.toFixed(p));

// ── B: raw HTTP streaming, measure TTFT + decode ────────────────────────
async function httpRun({ messages, tools }) {
  const body = JSON.stringify({
    model, messages, stream: true, stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS, temperature: TEMP,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  });
  const t0 = performance.now();
  const res = await fetch(`${endpoint}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
  let first, last, text = "", usage;
  const dec = new TextDecoder();
  let buf = "";
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (p === "[DONE]") continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      if (j.usage) usage = j.usage;
      const dtxt = j.choices?.[0]?.delta?.content;
      if (dtxt) { if (!first) first = performance.now(); last = performance.now(); text += dtxt; }
    }
  }
  const t1 = performance.now();
  const outTok = usage?.completion_tokens ?? estimateTokens(text).tokens;
  return {
    inputTok: usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n")).tokens,
    outputTok: outTok,
    ttft: first ? first - t0 : undefined,
    decodeMs: first && last ? last - first : undefined,
    decodeTps: first && last && outTok ? (outTok / (last - first)) * 1000 : undefined,
    totalMs: t1 - t0,
  };
}

// ── A: direct mlx_lm.generate ──────────────────────────────────────────
function mlxGenerate() {
  const py = profile.localService.command;
  const code = `
import time, mlx_lm
m, t = mlx_lm.load(${JSON.stringify(model)})
p = t.apply_chat_template([{"role":"user","content":${JSON.stringify(PROMPT)}}], add_generation_prompt=True)
import mlx_lm.generate as G
t0=time.time()
res = mlx_lm.generate(m, t, prompt=p, max_tokens=${MAX_TOKENS}, verbose=True)
`;
  const r = spawnSync(py, ["-c", code], { encoding: "utf8", timeout: 300000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const gen = out.match(/Generation:\s*([\d.]+)\s*tokens-per-sec/i) || out.match(/([\d.]+)\s*tokens-per-sec/i);
  const promptTps = out.match(/Prompt:\s*([\d.]+)\s*tokens-per-sec/i);
  const promptTok = out.match(/Prompt:\s*(\d+)\s*tokens/i);
  const genTok = out.match(/Generation:\s*(\d+)\s*tokens/i);
  const peak = out.match(/Peak memory:\s*([\d.]+)\s*GB/i);
  return {
    inputTok: promptTok ? Number(promptTok[1]) : undefined,
    outputTok: genTok ? Number(genTok[1]) : MAX_TOKENS,
    decodeTps: gen ? Number(gen[1]) : undefined,
    promptTps: promptTps ? Number(promptTps[1]) : undefined,
    peakGB: peak ? Number(peak[1]) : undefined,
    raw: out.slice(-400),
  };
}

// ── C / D via CONTINUUM ────────────────────────────────────────────────
async function continuumRun({ rendered, tools }) {
  let ttft, firstAt, lastAt, outCount = 0;
  const t0 = performance.now();
  const res = await runApiAgent({
    adapter, tools, rendered, query: PROMPT,
    contextLimit: profile.capabilities.contextWindowTokens,
    onStreamChunk: () => { if (!firstAt) firstAt = performance.now(); lastAt = performance.now(); outCount++; },
    limits: { maxIterations: 3, timeoutMs: 120000, stallThreshold: 3, maxStallSignals: 1 },
  });
  const t1 = performance.now();
  const t = res.telemetry;
  return {
    inputTok: t.inputTokens,
    outputTok: t.outputTokens,
    ttft: t.ttftMs,
    decodeMs: t.decodeMs,
    decodeTps: t.decodeTokPerSec,
    totalMs: t1 - t0,
    stopReason: res.stopReason,
  };
}

// ── build C + D inputs ─────────────────────────────────────────────────
const chatOnlyRendered = { protocol: "openai-compatible", system: "You are a helpful coding assistant.", userPrefix: "", cacheDirectives: [] };
const emptyTools = await buildToolRegistry({ dataDir: "/tmp/bench-empty", coding: undefined });

const ctx = await buildLauncherContext({ prompt: createPrompt() });
const prep = await ctx.launcher.prepareLaunch({ projectKey: PROJECT, providerId: PROVIDER, taskGoal: PROMPT }, { permissionMode: "safe" });
const fullTools = await buildToolRegistry({ dataDir: ctx.dataDir, coding: { projectPath: prep.project.path }, ...(prep.projectScope ? { memoryProjectScope: prep.projectScope } : {}) });

// token-cost breakdown
const systemText = Array.isArray(prep.rendered.system) ? prep.rendered.system.map((b) => b.text).join("\n") : prep.rendered.system;
const contextTok = estimateTokens(systemText + "\n" + prep.rendered.userPrefix).tokens;
const chatSystemTok = estimateTokens(chatOnlyRendered.system).tokens;
const fullSchemaTok = estimateTokens(JSON.stringify(toOpenAiTools(fullTools.list()))).tokens;
const fullToolNames = fullTools.list().map((t) => t.name);

console.log(`\nOrnith perf benchmark · prompt "${PROMPT.slice(0, 50)}…" · max_tokens=${MAX_TOKENS} · temp=${TEMP} · runs=${RUNS} (+1 warmup)\n`);
console.log(`context (D) system+prefix tokens : ${contextTok}`);
console.log(`context (C) system tokens        : ${chatSystemTok}`);
console.log(`tool schema (D) tokens           : ${fullSchemaTok}  [${fullToolNames.join(", ")}]`);
console.log(`context (C) tools                : none\n`);

const rows = [];

async function bench(label, fn) {
  await fn(); // warmup
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await fn());
  const m = (k) => median(runs.map((r) => r[k]).filter((x) => x !== undefined && !Number.isNaN(x)));
  const row = {
    label,
    inputTok: runs[0].inputTok,
    outputTok: Math.round(m("outputTok")),
    ttft: m("ttft"),
    decodeTps: m("decodeTps"),
    totalMs: m("totalMs"),
  };
  rows.push(row);
  console.log(`${label.padEnd(34)} in=${String(row.inputTok).padStart(5)}  out=${String(row.outputTok).padStart(4)}  TTFT=${fmt(row.ttft ? row.ttft / 1000 : undefined, 2).padStart(5)}s  decode=${fmt(row.decodeTps).padStart(6)} tok/s  total=${fmt(row.totalMs / 1000, 2).padStart(5)}s`);
  runs.forEach((r, i) => console.log(`   run ${i + 1}: TTFT=${fmt(r.ttft ? r.ttft / 1000 : undefined, 2)}s decode=${fmt(r.decodeTps)} tok/s total=${fmt((r.totalMs ?? 0) / 1000, 2)}s`));
}

// A
console.log("A. direct mlx_lm.generate (cold load each run — python process)…");
{
  const a = mlxGenerate();
  console.log(`A. direct mlx_lm.generate           in=${String(a.inputTok ?? "?").padStart(5)}  out=${String(a.outputTok).padStart(4)}  decode=${fmt(a.decodeTps).padStart(6)} tok/s  prompt=${fmt(a.promptTps)} tok/s  peak=${fmt(a.peakGB, 2)}GB`);
  rows.push({ label: "A. direct mlx_lm.generate", inputTok: a.inputTok, outputTok: a.outputTok, decodeTps: a.decodeTps });
}

await bench("B. direct mlx_lm HTTP (stream)", () => httpRun({ messages: [{ role: "user", content: PROMPT }] }));
await bench("C. CONTINUUM minimal (no tools)", () => continuumRun({ rendered: chatOnlyRendered, tools: emptyTools }));
await bench("D. CONTINUUM full harness", () => continuumRun({ rendered: prep.rendered, tools: fullTools }));

console.log("\n=== summary (median) ===");
console.log("path                                input  output  TTFT     decode tok/s");
for (const r of rows) {
  console.log(`${r.label.padEnd(34)} ${String(r.inputTok ?? "—").padStart(5)}  ${String(r.outputTok ?? "—").padStart(6)}  ${fmt(r.ttft ? r.ttft / 1000 : undefined, 2).padStart(6)}s  ${fmt(r.decodeTps).padStart(6)}`);
}
console.log(`
NOTE on decode tok/s reliability:
  A (mlx_lm.generate): a fresh python process is loaded per run — the number
    reflects cold-load + possible thermal throttle, NOT steady-state decode.
    Trust the standalone baseline the harness was given instead.
  B (raw HTTP): mlx_lm.server flushes SSE frames in bursts, so first→last
    delta timestamps compress and the derived rate is inflated. TTFT is real.
  C / D (CONTINUUM): decodeMs = firstToken → stream-end, so read coalescing
    can only LENGTHEN the window — this rate is a conservative under-estimate
    and is the one to compare against the baseline.
`);
process.exit(0);
