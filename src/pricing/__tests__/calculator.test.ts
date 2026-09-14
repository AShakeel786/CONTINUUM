import { describe, expect, it } from "vitest";
import { getCurrentTier, getNextTransition } from "../calculator.js";
import { deepseekPricingSchedule } from "../schedules/deepseek.js";
import type { ProviderPricingSchedule } from "../types.js";

const schedule = deepseekPricingSchedule;

// Weekday anchor: 2026-08-17 is a Monday (UTC).
const MON = "2026-08-17";
const TUE = "2026-08-18";
const FRI = "2026-08-21";
const SAT = "2026-08-22";
const SUN = "2026-08-23";

describe("getCurrentTier — off-peak detection (Monday)", () => {
  it("reports off-peak for a time between the two peak windows", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T05:00:00.000Z`))).toBe("off-peak");
  });

  it("reports off-peak for a time well outside both windows", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T15:00:00.000Z`))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date(`${MON}T23:59:00.000Z`))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date(`${MON}T00:00:00.000Z`))).toBe("off-peak");
  });
});

describe("getCurrentTier — both peak windows (Monday)", () => {
  it("reports peak inside the first window (01:00-04:00 UTC)", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T02:30:00.000Z`))).toBe("peak");
  });

  it("reports peak inside the second window (06:00-10:00 UTC)", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T08:00:00.000Z`))).toBe("peak");
  });
});

describe("getCurrentTier — weekday gating (September 2026 official schedule)", () => {
  it("weekends are off-peak even inside the UTC windows", () => {
    // Saturday and Sunday at the same instants that are peak on Monday.
    expect(getCurrentTier(schedule, new Date(`${SAT}T02:30:00.000Z`))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date(`${SAT}T08:00:00.000Z`))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date(`${SUN}T02:30:00.000Z`))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date(`${SUN}T08:00:00.000Z`))).toBe("off-peak");
  });

  it("the same UTC instant is peak on a weekday and off-peak on a weekend", () => {
    expect(getCurrentTier(schedule, new Date(`${FRI}T08:00:00.000Z`))).toBe("peak");
    expect(getCurrentTier(schedule, new Date(`${SAT}T08:00:00.000Z`))).toBe("off-peak");
  });

  it("Friday's second window still ends at 10:00 UTC — no spill into the weekend", () => {
    expect(getCurrentTier(schedule, new Date(`${FRI}T09:59:59.999Z`))).toBe("peak");
    expect(getCurrentTier(schedule, new Date(`${FRI}T10:00:00.000Z`))).toBe("off-peak");
    expect(getCurrentTier(schedule, new Date(`${FRI}T23:00:00.000Z`))).toBe("off-peak");
  });

  it("a schedule without peakDaysUTC keeps the historical daily-repeating behavior", () => {
    const daily: ProviderPricingSchedule = {
      providerId: "test-daily",
      peakWindows: [{ startUTC: "01:00", endUTC: "04:00" }],
    };
    expect(getCurrentTier(daily, new Date(`${SUN}T02:00:00.000Z`))).toBe("peak");
  });
});

describe("getCurrentTier — exact boundary times ([start, end) semantics)", () => {
  it("first window: peak starts exactly at 01:00:00.000 UTC (inclusive)", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T01:00:00.000Z`))).toBe("peak");
    expect(getCurrentTier(schedule, new Date(`${MON}T00:59:59.999Z`))).toBe("off-peak");
  });

  it("first window: peak ends exactly at 04:00:00.000 UTC (exclusive)", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T03:59:59.999Z`))).toBe("peak");
    expect(getCurrentTier(schedule, new Date(`${MON}T04:00:00.000Z`))).toBe("off-peak");
  });

  it("second window: peak starts exactly at 06:00:00.000 UTC (inclusive)", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T06:00:00.000Z`))).toBe("peak");
    expect(getCurrentTier(schedule, new Date(`${MON}T05:59:59.999Z`))).toBe("off-peak");
  });

  it("second window: peak ends exactly at 10:00:00.000 UTC (exclusive)", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T09:59:59.999Z`))).toBe("peak");
    expect(getCurrentTier(schedule, new Date(`${MON}T10:00:00.000Z`))).toBe("off-peak");
  });
});

describe("getNextTransition", () => {
  it("from just before the first window, next transition is into peak at 01:00 UTC", () => {
    const t = getNextTransition(schedule, new Date(`${MON}T00:00:00.000Z`));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe(`${MON}T01:00:00.000Z`);
  });

  it("from inside the first window, next transition is out of peak at 04:00 UTC", () => {
    const t = getNextTransition(schedule, new Date(`${MON}T02:00:00.000Z`));
    expect(t?.toTier).toBe("off-peak");
    expect(t?.at.toISOString()).toBe(`${MON}T04:00:00.000Z`);
  });

  it("from the gap between windows, next transition is into peak at 06:00 UTC", () => {
    const t = getNextTransition(schedule, new Date(`${MON}T04:30:00.000Z`));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe(`${MON}T06:00:00.000Z`);
  });

  it("from after the last window of the day, next transition rolls over to tomorrow's first window", () => {
    const t = getNextTransition(schedule, new Date(`${MON}T12:00:00.000Z`));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe(`${TUE}T01:00:00.000Z`);
  });

  it("from Friday after the last window, next transition is MONDAY 01:00 UTC (the weekend is skipped)", () => {
    const t = getNextTransition(schedule, new Date(`${FRI}T12:00:00.000Z`));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe("2026-08-24T01:00:00.000Z");
  });

  it("from Saturday, the weekend has no transitions — next is Monday 01:00 UTC", () => {
    const t = getNextTransition(schedule, new Date(`${SAT}T00:00:00.000Z`));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe("2026-08-24T01:00:00.000Z");
  });

  it("correctly rolls over across a month boundary", () => {
    // 2026-08-31 is a Monday; 2026-09-01 a Tuesday.
    const t = getNextTransition(schedule, new Date("2026-08-31T23:00:00.000Z"));
    expect(t?.at.toISOString()).toBe("2026-09-01T01:00:00.000Z");
  });

  it("correctly rolls over across a year boundary", () => {
    // 2026-12-31 is a Thursday; the next peak is Friday 2027-01-01 01:00 UTC.
    const t = getNextTransition(schedule, new Date("2026-12-31T23:00:00.000Z"));
    expect(t?.toTier).toBe("peak");
    expect(t?.at.toISOString()).toBe("2027-01-01T01:00:00.000Z");
  });

  it("returns undefined for a schedule with no peak windows at all", () => {
    const empty: ProviderPricingSchedule = { providerId: "always-off-peak", peakWindows: [] };
    expect(getNextTransition(empty, new Date(`${MON}T00:00:00.000Z`))).toBeUndefined();
  });

  it("getCurrentTier for a schedule with no peak windows is always off-peak", () => {
    const empty: ProviderPricingSchedule = { providerId: "always-off-peak", peakWindows: [] };
    expect(getCurrentTier(empty, new Date(`${MON}T02:00:00.000Z`))).toBe("off-peak");
  });

  it("handles a midnight-crossing window correctly (generality beyond DeepSeek's current schedule)", () => {
    const crossesMidnight: ProviderPricingSchedule = {
      providerId: "test-provider",
      peakWindows: [{ startUTC: "22:00", endUTC: "02:00" }],
    };
    expect(getCurrentTier(crossesMidnight, new Date(`${SUN}T23:00:00.000Z`))).toBe("peak");
    expect(getCurrentTier(crossesMidnight, new Date(`${MON}T01:00:00.000Z`))).toBe("peak");
    expect(getCurrentTier(crossesMidnight, new Date(`${MON}T02:00:00.000Z`))).toBe("off-peak");
    expect(getCurrentTier(crossesMidnight, new Date(`${SUN}T21:00:00.000Z`))).toBe("off-peak");
  });
});

describe("Toronto DST rendering does not alter UTC billing classification", () => {
  // Classification is UTC-only: converting the same instant into a local
  // zone (EDT here) must never change the tier.
  it("Monday 01:30 UTC (Sunday 21:30 EDT, evening before) is peak", () => {
    const instant = new Date(`${MON}T01:30:00.000Z`);
    expect(getCurrentTier(schedule, instant)).toBe("peak");
    const toronto = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
    expect(toronto).toBe("21:30"); // local rendering says Sunday evening; UTC still governs
  });

  it("Monday 06:30 UTC (02:30 EDT) is peak in both summer and winter schedules", () => {
    expect(getCurrentTier(schedule, new Date(`${MON}T06:30:00.000Z`))).toBe("peak");
  });

  it("EST boundary: a November instant keeps the same classification as its UTC time says", () => {
    // 2026-11-02 is a Monday (EST in Toronto). 07:00 UTC = 02:00 EST — peak.
    expect(getCurrentTier(schedule, new Date("2026-11-02T07:00:00.000Z"))).toBe("peak");
    // 05:00 UTC = 00:00 EST — gap between windows, off-peak.
    expect(getCurrentTier(schedule, new Date("2026-11-02T05:00:00.000Z"))).toBe("off-peak");
  });

  it("EDT boundary: a July instant keeps the same classification", () => {
    // 2026-07-13 is a Monday (EDT). 07:00 UTC = 03:00 EDT — peak.
    expect(getCurrentTier(schedule, new Date("2026-07-13T07:00:00.000Z"))).toBe("peak");
  });
});
