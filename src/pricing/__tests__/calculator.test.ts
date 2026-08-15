import { describe, expect, it } from "vitest";
import { getCurrentTier, getNextTransition } from "../calculator.js";
import { deepseekPricingSchedule } from "../schedules/deepseek.js";
import type { ProviderPricingSchedule } from "../types.js";

const schedule = deepseekPricingSchedule;

describe("getCurrentTier — off-peak detection", () => {
  it("reports off-peak for a time between the two peak windows", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T05:00:00.000Z"))).toBe("off-peak");
  });

  it("reports off-peak for a time well outside both windows", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T15:00:00.000Z"))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date("2026-08-16T23:59:00.000Z"))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date("2026-08-16T00:00:00.000Z"))).toBe("off-peak");
  });
});

describe("getCurrentTier — both peak windows", () => {
  it("reports peak inside the first window (01:00-04:00 UTC)", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T02:30:00.000Z"))).toBe("peak");
  });

  it("reports peak inside the second window (06:00-10:00 UTC)", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T08:00:00.000Z"))).toBe("peak");
  });
});

describe("getCurrentTier — exact boundary times ([start, end) semantics)", () => {
  it("first window: peak starts exactly at 01:00:00.000 UTC (inclusive)", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T01:00:00.000Z"))).toBe("peak");
    expect(getCurrentTier(schedule, new Date("2026-08-16T00:59:59.999Z"))).toBe("off-peak");
  });

  it("first window: peak ends exactly at 04:00:00.000 UTC (exclusive)", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T03:59:59.999Z"))).toBe("peak");
    expect(getCurrentTier(schedule, new Date("2026-08-16T04:00:00.000Z"))).toBe("off-peak");
  });

  it("second window: peak starts exactly at 06:00:00.000 UTC (inclusive)", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T06:00:00.000Z"))).toBe("peak");
    expect(getCurrentTier(schedule, new Date("2026-08-16T05:59:59.999Z"))).toBe("off-peak");
  });

  it("second window: peak ends exactly at 10:00:00.000 UTC (exclusive)", () => {
    expect(getCurrentTier(schedule, new Date("2026-08-16T09:59:59.999Z"))).toBe("peak");
    expect(getCurrentTier(schedule, new Date("2026-08-16T10:00:00.000Z"))).toBe("off-peak");
  });
});

describe("getNextTransition", () => {
  it("from just before the first window, next transition is into peak at 01:00 UTC", () => {
    const t = getNextTransition(schedule, new Date("2026-08-16T00:00:00.000Z"));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe("2026-08-16T01:00:00.000Z");
  });

  it("from inside the first window, next transition is out of peak at 04:00 UTC", () => {
    const t = getNextTransition(schedule, new Date("2026-08-16T02:00:00.000Z"));
    expect(t?.toTier).toBe("off-peak");
    expect(t?.at.toISOString()).toBe("2026-08-16T04:00:00.000Z");
  });

  it("from the gap between windows, next transition is into peak at 06:00 UTC", () => {
    const t = getNextTransition(schedule, new Date("2026-08-16T04:30:00.000Z"));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe("2026-08-16T06:00:00.000Z");
  });

  it("from after the last window of the day, next transition rolls over to tomorrow's first window", () => {
    const t = getNextTransition(schedule, new Date("2026-08-16T12:00:00.000Z"));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe("2026-08-17T01:00:00.000Z");
  });

  it("correctly rolls over across a month boundary", () => {
    const t = getNextTransition(schedule, new Date("2026-08-31T23:00:00.000Z"));
    expect(t?.at.toISOString()).toBe("2026-09-01T01:00:00.000Z");
  });

  it("returns undefined for a schedule with no peak windows at all", () => {
    const empty: ProviderPricingSchedule = { providerId: "always-off-peak", peakWindows: [] };
    expect(getNextTransition(empty, new Date("2026-08-16T00:00:00.000Z"))).toBeUndefined();
  });

  it("getCurrentTier for a schedule with no peak windows is always off-peak", () => {
    const empty: ProviderPricingSchedule = { providerId: "always-off-peak", peakWindows: [] };
    expect(getCurrentTier(empty, new Date("2026-08-16T02:00:00.000Z"))).toBe("off-peak");
  });

  it("handles a midnight-crossing window correctly (generality beyond DeepSeek's current schedule)", () => {
    const crossesMidnight: ProviderPricingSchedule = {
      providerId: "test-provider",
      peakWindows: [{ startUTC: "22:00", endUTC: "02:00" }],
    };
    expect(getCurrentTier(crossesMidnight, new Date("2026-08-16T23:00:00.000Z"))).toBe("peak");
    expect(getCurrentTier(crossesMidnight, new Date("2026-08-17T01:00:00.000Z"))).toBe("peak");
    expect(getCurrentTier(crossesMidnight, new Date("2026-08-17T02:00:00.000Z"))).toBe("off-peak");
    expect(getCurrentTier(crossesMidnight, new Date("2026-08-16T21:00:00.000Z"))).toBe("off-peak");
  });
});
