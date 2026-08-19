import { promises as fs } from "node:fs";
import { buildLauncherContext } from "./launcher-context.js";
import { launchPrepared } from "./launch.js";
import { spawnCliCaptured } from "../../launcher/spawn.js";
import { createPrompt, noopOutput } from "../../auth/prompt.js";
import { nativeSessionFile, readClaudeTurns, readClaudeUsage } from "../../cost/native-usage.js";
import { CostTelemetryStore } from "../../cost/telemetry.js";
import { estimateCostUsd } from "../../cost/calculator.js";
import type { CliIo } from "../index.js";

const DEFAULT_CEILING_USD = 0.05;
const SMOKE_PROMPT = "Reply with exactly CONTINUUM_DEEPSEEK_SMOKE_OK and nothing else.";

function printPlan(prep: import("../../launcher/types.js").LaunchPreparation): import("../../launcher/types.js").LaunchPreparation {
  const args = [...prep.plan.args];
  const prompt = args.pop();
  return {
    ...prep,
    // Claude Code's --max-budget-usd uses its own Anthropic price table and
    // rejects valid DeepSeek requests as over-budget. CONTINUUM performs the
    // provider-specific ceiling check before launch and rechecks actual
    // DeepSeek-estimated usage after the turn instead.
    plan: { ...prep.plan, args: [...args, "--print", "--output-format", "json", ...(prompt ? [prompt] : [])] },
  };
}

async function nativeEvidence(prep: import("../../launcher/types.js").LaunchPreparation): Promise<{ turns: number; response: boolean; usage?: Awaited<ReturnType<typeof readClaudeUsage>> }> {
  // Claude's print mode may omit the session id from JSONL records, while
  // CONTINUUM's deterministic launch id is persisted asynchronously. Prefer
  // the persisted native id and fall back to the logical id for this test.
  const id = prep.session?.nativeSessionIds?.deepseek ?? prep.session?.sessionId;
  if (!id) return { turns: 0, response: false };
  const launch = (await buildLauncherContext({ prompt: createPrompt() })).providers.get("deepseek").resolveCliLaunch(prep.route);
  const file = launch.nativeResume?.supported ? await nativeSessionFile(launch.nativeResume.sessionStore, id) : undefined;
  if (!file) return { turns: 0, response: false };
  const text = await fs.readFile(file, "utf8");
  return { turns: (await readClaudeTurns(file)).length, response: text.includes("CONTINUUM_DEEPSEEK_SMOKE_OK"), usage: await readClaudeUsage(file) };
}

export async function runDeepSeekSmokeCommand(args: readonly string[], io: CliIo): Promise<number> {
  const out = io.out ?? noopOutput();
  const ceiling = Number(args.find((a) => a.startsWith("--max-usd="))?.slice("--max-usd=".length) ?? DEFAULT_CEILING_USD);
  if (!Number.isFinite(ceiling) || ceiling <= 0) { out("DeepSeek live check: FAIL\nStage: ceiling\nReason: --max-usd must be positive.\n"); return 2; }
  const prompt = createPrompt();
  const ctx = await buildLauncherContext({ prompt });
  const usable = (await ctx.launcher.listAuthenticatedProviders()).some((p) => p.providerId === "deepseek");
  if (!usable) { out("DeepSeek live check: FAIL\nStage: auth\nReason: DeepSeek credential is unavailable.\n"); return 2; }
  let prep: import("../../launcher/types.js").LaunchPreparation;
  try {
    prep = await ctx.launcher.prepareLaunch({ mode: "general", providerId: "deepseek", taskGoal: SMOKE_PROMPT }, { permissionMode: "safe" });
  } catch (err) {
    out(`DeepSeek live check: FAIL\nStage: preparation\nReason: ${err instanceof Error ? err.message : String(err)}\n`); return 1;
  }
  const peak = ctx.pricing.status("deepseek");
  const projected = estimateCostUsd({ inputTokens: prep.contextTokensUsed, cacheHitTokens: 0, cacheMissTokens: prep.contextTokensUsed, outputTokens: 64, contextTokens: prep.contextTokensUsed, turns: 1 }, prep.providerRef.model, peak?.multiplier ?? 1);
  if (prep.providerRef.model !== "deepseek-v4-flash") { out("DeepSeek live check: FAIL\nStage: routing\nReason: default model was not deepseek-v4-flash.\n"); return 1; }
  if (projected > ceiling) { out(`DeepSeek live check: ABORTED\nStage: ceiling\nProjected estimate: $${projected.toFixed(4)} > $${ceiling.toFixed(4)}\n`); return 2; }
  const smokePrep = printPlan(prep);
  const code = await launchPrepared(ctx, smokePrep, out, async (plan) => {
    const result = await spawnCliCaptured(plan);
    return { exitCode: result.exitCode };
  });
  const first = await nativeEvidence(smokePrep);
  if (code !== 0 || !first.response || first.turns === 0) {
    await ctx.sessionManager.setStatus(prep.session!.sessionId, "abandoned").catch(() => {});
    out(`DeepSeek live check: FAIL\nStage: response\nExit: ${code}\nTelemetry: ${first.turns > 0 ? "present" : "missing"}\nSession: ${prep.session!.sessionId}\n`); return 1;
  }

  const resumed = await ctx.launcher.prepareLaunch({ sessionId: prep.session!.sessionId }, { permissionMode: "safe" });
  if (resumed.providerRef.model !== "deepseek-v4-flash") { out("DeepSeek live check: FAIL\nStage: resume-routing\nReason: resumed model was not Flash.\n"); return 1; }
  const resumeCode = await launchPrepared(ctx, printPlan(resumed), out, async (plan) => {
    const result = await spawnCliCaptured(plan);
    return { exitCode: result.exitCode };
  });
  const second = await nativeEvidence(resumed);
  await ctx.sessionManager.setStatus(prep.session!.sessionId, "completed");
  const events = await new CostTelemetryStore(ctx.dataDir).list(prep.session!.sessionId);
  const estimated = events.reduce((sum, e) => sum + (e.estimatedUsd ?? 0), 0);
  const withinCeiling = estimated <= ceiling;
  out(`DeepSeek live check: ${resumeCode === 0 && second.turns > first.turns && withinCeiling ? "PASS" : "FAIL"}\n`);
  out(`Auth:       OK\nRoute:      ${prep.route}\nModel:      ${prep.providerRef.model}\nResponse:   OK\nTelemetry:  ${second.turns > first.turns ? "OK" : "FAIL"}\nResume:     ${resumeCode === 0 && resumed.providerRef.model === "deepseek-v4-flash" ? "OK" : "FAIL"}\nPeak:       ${peak?.tier === "peak" ? `peak ${peak.multiplier}×` : "off-peak"}\nEst. cost:  $${estimated.toFixed(4)}\nSession:    ${prep.session!.sessionId}\n`);
  return resumeCode === 0 && second.turns > first.turns && withinCeiling ? 0 : 1;
}
