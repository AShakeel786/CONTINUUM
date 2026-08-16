/**
 * Tool Output Optimizer — dispatcher + telemetry. Deterministic and
 * LLM-free. Selects an optimizer by tool name + content shape (never by
 * provider identity), applies it, and — only when it provably reduced the
 * text — retains the complete original out-of-band and returns a
 * `tool-output://<id>` reference. If no safe optimization applies, the
 * original passes through unchanged.
 */

import { estimateTokens } from "../token/tokenizer.js";
import {
  dedupeLogs,
  dedupeRepeatedLines,
  optimizeCompiler,
  optimizeFileListing,
  optimizeGitDiff,
  optimizeGitLog,
  optimizeGitStatus,
  optimizeJson,
  optimizeTestRunner,
  truncateMiddle,
} from "./optimizers.js";
import type { OptimizedToolOutput, OptimizerKind, OptimizerTelemetry, OptimizeOptions } from "./types.js";
import { DEFAULT_OPTIMIZE_OPTIONS } from "./types.js";
import { defaultRawStore, type RawOutputStore } from "./store.js";

type OptimizerFn = (text: string) => string | undefined;

/** Tool-name hints (weak; content sniffing still decides). */
const NAME_HINTS: Readonly<Record<string, readonly OptimizerKind[]>> = {
  git: ["git-status", "git-log", "git-diff"],
  "git status": ["git-status"],
  "git log": ["git-log"],
  "git diff": ["git-diff"],
  test: ["test-runner"],
  npm: ["test-runner", "log-dedup"],
  pytest: ["test-runner"],
  jest: ["test-runner"],
  vitest: ["test-runner"],
  tsc: ["compiler"],
  eslint: ["compiler"],
  ruff: ["compiler"],
  ls: ["file-listing"],
  find: ["file-listing"],
  cat: ["json", "log-dedup", "repeated-lines"],
};

const OPTIMIZERS: ReadonlyArray<{ kind: OptimizerKind; fn: OptimizerFn }> = [
  { kind: "json", fn: optimizeJson },
  { kind: "test-runner", fn: optimizeTestRunner },
  { kind: "compiler", fn: optimizeCompiler },
  { kind: "git-status", fn: optimizeGitStatus },
  { kind: "git-log", fn: optimizeGitLog },
  { kind: "git-diff", fn: optimizeGitDiff },
  { kind: "file-listing", fn: optimizeFileListing },
  { kind: "log-dedup", fn: dedupeLogs },
  { kind: "repeated-lines", fn: dedupeRepeatedLines },
];

function orderedOptimizers(toolName: string): readonly { kind: OptimizerKind; fn: OptimizerFn }[] {
  const hints = NAME_HINTS[toolName] ?? NAME_HINTS[toolName.toLowerCase()] ?? [];
  const hinted = hints.map((k) => OPTIMIZERS.find((o) => o.kind === k)!).filter(Boolean);
  const rest = OPTIMIZERS.filter((o) => !hinted.includes(o));
  return [...hinted, ...rest];
}

export function optimizeToolOutput(
  toolName: string,
  text: string,
  opts: OptimizeOptions = DEFAULT_OPTIMIZE_OPTIONS,
  store: RawOutputStore = defaultRawStore,
): OptimizedToolOutput {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes < opts.minBytes) {
    return passthrough(text, originalBytes);
  }

  // Try each optimizer in (hint-then-generic) order; first safe reduction wins.
  for (const { kind, fn } of orderedOptimizers(toolName)) {
    let optimized: string | undefined;
    try {
      optimized = fn(text);
    } catch {
      continue;
    }
    if (optimized === undefined || optimized === text) continue;
    if (Buffer.byteLength(optimized, "utf8") >= originalBytes) continue; // no reduction → not safe/beneficial

    const id = store.put(text);
    const telemetry = computeTelemetry(text, optimized, originalBytes, kind, true);
    return { text: optimized, rawRef: `tool-output://${id}`, telemetry };
  }

  // Final fallback: generic truncation for very large output.
  const truncated = truncateMiddle(text, opts.truncateLines);
  if (truncated && Buffer.byteLength(truncated, "utf8") < originalBytes) {
    const id = store.put(text);
    const telemetry = computeTelemetry(text, truncated, originalBytes, "truncate", true);
    return { text: truncated, rawRef: `tool-output://${id}`, telemetry };
  }

  return passthrough(text, originalBytes);
}

function passthrough(text: string, originalBytes: number): OptimizedToolOutput {
  const tokens = estimateTokens(text).tokens;
  const telemetry: OptimizerTelemetry = {
    originalBytes,
    optimizedBytes: originalBytes,
    originalTokens: tokens,
    optimizedTokens: tokens,
    tokensSaved: 0,
    percentSaved: 0,
    optimizer: "passthrough",
    rawRetained: false,
  };
  return { text, telemetry };
}

function computeTelemetry(original: string, optimized: string, originalBytes: number, kind: OptimizerKind, rawRetained: boolean): OptimizerTelemetry {
  const optimizedBytes = Buffer.byteLength(optimized, "utf8");
  const originalTokens = estimateTokens(original).tokens;
  const optimizedTokens = estimateTokens(optimized).tokens;
  const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
  const percentSaved = originalTokens > 0 ? Number(((tokensSaved / originalTokens) * 100).toFixed(1)) : 0;
  return {
    originalBytes,
    optimizedBytes,
    originalTokens,
    optimizedTokens,
    tokensSaved,
    percentSaved,
    optimizer: kind,
    rawRetained,
  };
}

/** Short human-readable telemetry line (for onEvent / benchmarks). */
export function telemetryLine(t: OptimizerTelemetry): string {
  return `${t.optimizer}: ${t.originalTokens}→${t.optimizedTokens} tok (-${t.percentSaved}%) [${t.originalBytes}→${t.optimizedBytes} B]${t.rawRetained ? " raw-retained" : ""}`;
}
