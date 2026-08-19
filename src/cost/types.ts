export interface TokenUsageEstimate {
  readonly inputTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly outputTokens: number;
  readonly contextTokens: number;
  readonly turns: number;
}

export interface ModelPrices {
  readonly cacheHitPerMillion: number;
  readonly cacheMissPerMillion: number;
  readonly outputPerMillion: number;
}

export interface CostTelemetryEvent {
  readonly schemaVersion: 1;
  readonly at: string;
  readonly logicalSessionId: string;
  readonly nativeSessionId?: string;
  readonly providerId: string;
  readonly model: string;
  readonly kind: "turn" | "rollover" | "model-tier";
  readonly estimate: true;
  readonly peak: boolean;
  readonly multiplier: number;
  readonly usage?: TokenUsageEstimate;
  readonly estimatedUsd?: number;
  readonly estimatedCostAvoidedUsd?: number;
  readonly reason?: string;
}
