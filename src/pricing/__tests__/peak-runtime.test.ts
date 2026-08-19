import { describe, expect, it } from "vitest";
import { formatLocalClock } from "../format.js";
import { getCurrentTier } from "../calculator.js";
import { deepseekPricingSchedule } from "../schedules/deepseek.js";
describe("peak runtime and timezone boundaries", () => {
  it("detects launch inside peak", () => expect(getCurrentTier(deepseekPricingSchedule, new Date("2026-08-18T02:17:00Z"))).toBe("peak"));
  it("uses a half-open end", () => expect(getCurrentTier(deepseekPricingSchedule, new Date("2026-08-18T04:00:00Z"))).toBe("off-peak"));
  it("formats across Toronto DST using IANA rules", () => expect(formatLocalClock(new Date("2026-03-08T06:30:00Z"), "America/Toronto")).not.toBe(formatLocalClock(new Date("2026-03-08T07:30:00Z"), "America/Toronto")));
});
