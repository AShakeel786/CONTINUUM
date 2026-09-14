import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CostTelemetryStore } from "../telemetry.js";
import { effectivePricingModel, estimateCostUsd } from "../calculator.js";

it("persists labelled estimates", async () => {
  const store = new CostTelemetryStore(await mkdtemp(join(tmpdir(), "continuum-cost-")));
  await store.append({ schemaVersion: 1, at: "2026-08-18T00:00:00Z", logicalSessionId: "s", providerId: "deepseek", model: "deepseek-v4-flash", kind: "turn", estimate: true, peak: false, multiplier: 1, estimatedUsd: .01 });
  expect((await store.list("s"))[0]?.estimate).toBe(true);
  expect(await store.list("other")).toEqual([]);
});

it("records effectiveModel/pricingModel attribution without disturbing legacy reads", async () => {
  const store = new CostTelemetryStore(await mkdtemp(join(tmpdir(), "continuum-cost-")));
  const usage = { inputTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10, outputTokens: 5, contextTokens: 10, turns: 1 };
  await store.append({
    schemaVersion: 1, at: "2026-08-18T00:00:00Z", logicalSessionId: "s", providerId: "deepseek",
    model: "deepseek-v4-pro", kind: "turn", estimate: true, peak: false, multiplier: 1,
    usage, estimatedUsd: estimateCostUsd(usage, "deepseek-v4-pro", 1),
    effectiveModel: "DeepSeek V4.1 Flash", pricingModel: effectivePricingModel("deepseek-v4-pro"),
  });
  const [event] = await store.list("s");
  // Requested model preserved verbatim; attribution fields identify what
  // upstream actually served and which tariff applied.
  expect(event?.model).toBe("deepseek-v4-pro");
  expect(event?.effectiveModel).toBe("DeepSeek V4.1 Flash");
  expect(event?.pricingModel).toBe("deepseek-flash");
  // The pro-alias request was priced at V4.1 Flash rates.
  expect(event?.estimatedUsd).toBeCloseTo((10 * 0.15 + 5 * 0.6) / 1_000_000);
});

it("legacy events without the new fields still read cleanly", async () => {
  const store = new CostTelemetryStore(await mkdtemp(join(tmpdir(), "continuum-cost-")));
  await store.append({ schemaVersion: 1, at: "2026-08-18T00:00:00Z", logicalSessionId: "old", providerId: "deepseek", model: "deepseek-v4-flash", kind: "turn", estimate: true, peak: false, multiplier: 1, estimatedUsd: .01 });
  const [event] = await store.list("old");
  expect(event?.model).toBe("deepseek-v4-flash");
  expect(event?.effectiveModel).toBeUndefined();
  expect(event?.pricingModel).toBeUndefined();
});
