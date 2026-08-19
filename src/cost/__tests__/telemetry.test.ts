import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CostTelemetryStore } from "../telemetry.js";
it("persists labelled estimates", async () => {
  const store = new CostTelemetryStore(await mkdtemp(join(tmpdir(), "continuum-cost-")));
  await store.append({ schemaVersion: 1, at: "2026-08-18T00:00:00Z", logicalSessionId: "s", providerId: "deepseek", model: "deepseek-v4-flash", kind: "turn", estimate: true, peak: false, multiplier: 1, estimatedUsd: .01 });
  expect((await store.list("s"))[0]?.estimate).toBe(true);
  expect(await store.list("other")).toEqual([]);
});
