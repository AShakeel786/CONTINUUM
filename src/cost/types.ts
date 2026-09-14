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
  /**
   * What upstream actually served the request, as a display name (e.g.
   * "DeepSeek V4.1 Flash" when the requested `deepseek-v4-pro` alias is
   * currently routed to V4.1 Flash). Kept next to `model` (the requested
   * id) so upstream routing transitions stay auditable without rewriting
   * historical events.
   */
  readonly effectiveModel?: string;
  /**
   * The canonical provider model id whose tariff the estimate used (e.g.
   * `deepseek-flash` for a `deepseek-v4-pro` request billed at V4.1 Flash
   * rates). Absent on historical events written before this field existed.
   */
  readonly pricingModel?: string;
}
