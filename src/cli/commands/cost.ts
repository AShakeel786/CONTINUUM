import { resolveDataDir } from "../../config/paths.js";
import { CostTelemetryStore } from "../../cost/telemetry.js";
import type { CliIo } from "../index.js";

export async function runCostCommand(args: readonly string[], io: CliIo): Promise<number> {
  const events = await new CostTelemetryStore(resolveDataDir()).list(args.find((a) => !a.startsWith("-")));
  const turns = events.filter((e) => e.kind === "turn");
  const usd = turns.reduce((n, e) => n + (e.estimatedUsd ?? 0), 0);
  const avoided = events.reduce((n, e) => n + (e.estimatedCostAvoidedUsd ?? 0), 0);
  const hit = turns.reduce((n, e) => n + (e.usage?.cacheHitTokens ?? 0), 0);
  const miss = turns.reduce((n, e) => n + (e.usage?.cacheMissTokens ?? 0), 0);
  const output = turns.reduce((n, e) => n + (e.usage?.outputTokens ?? 0), 0);
  io.out?.(`Estimated DeepSeek cost (not billing): $${usd.toFixed(4)}\nCache hit: ${hit.toLocaleString()} | cache miss: ${miss.toLocaleString()} | output: ${output.toLocaleString()}\nEstimated cost avoided: $${avoided.toFixed(4)} | telemetry records: ${events.length}\nCross-check with a DeepSeek billing export before claiming savings.\n`);
  return 0;
}
