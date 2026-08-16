/**
 * Tool Output Optimizer types. Deterministic, lossless-first, LLM-free.
 * No provider identity here — dispatch is on tool name + content shape.
 */

export type OptimizerKind =
  | "json"
  | "test-runner"
  | "compiler"
  | "git-status"
  | "git-log"
  | "git-diff"
  | "file-listing"
  | "log-dedup"
  | "repeated-lines"
  | "truncate"
  | "passthrough";

export interface OptimizerTelemetry {
  readonly originalBytes: number;
  readonly optimizedBytes: number;
  readonly originalTokens: number;
  readonly optimizedTokens: number;
  readonly tokensSaved: number;
  readonly percentSaved: number;
  readonly optimizer: OptimizerKind;
  readonly rawRetained: boolean;
}

export interface OptimizedToolOutput {
  /** The text that enters the model context (optimized, or original when passthrough). */
  readonly text: string;
  /** `tool-output://<id>` reference when the raw output was retained. */
  readonly rawRef?: string;
  readonly telemetry: OptimizerTelemetry;
}

export interface OptimizeOptions {
  /** Lower bound of original bytes before any optimization/retention is attempted. */
  readonly minBytes: number;
  /** Max lines to keep in a truncated passthrough (head+tail). */
  readonly truncateLines: number;
}

export const DEFAULT_OPTIMIZE_OPTIONS: OptimizeOptions = { minBytes: 400, truncateLines: 200 };
