import { describe, expect, it } from "vitest";
import { describeTransition, formatLocalClock, formatRelativeDuration, formatUtcClock } from "../format.js";

describe("formatUtcClock", () => {
  it("formats a UTC time as HH:MM UTC", () => {
    expect(formatUtcClock(new Date("2026-08-16T01:00:00.000Z"))).toBe("01:00 UTC");
    expect(formatUtcClock(new Date("2026-08-16T23:05:00.000Z"))).toBe("23:05 UTC");
  });
});

describe("formatLocalClock — UTC/local-time conversion", () => {
  it("converts a UTC instant to a specific IANA timezone's local clock time", () => {
    // 01:00 UTC on 2026-08-16 is 21:00 the previous day in America/New_York (EDT, UTC-4 in August).
    expect(formatLocalClock(new Date("2026-08-16T01:00:00.000Z"), "America/New_York")).toBe("21:00");
  });

  it("converts correctly for a timezone ahead of UTC", () => {
    // 01:00 UTC is 09:00 in Asia/Shanghai (UTC+8, no DST).
    expect(formatLocalClock(new Date("2026-08-16T01:00:00.000Z"), "Asia/Shanghai")).toBe("09:00");
  });

  it("uses the host's local timezone when none is specified (doesn't throw)", () => {
    expect(() => formatLocalClock(new Date("2026-08-16T01:00:00.000Z"))).not.toThrow();
  });
});

describe("formatRelativeDuration", () => {
  it("formats sub-hour durations in minutes", () => {
    expect(formatRelativeDuration(15 * 60_000)).toBe("15 minutes");
    expect(formatRelativeDuration(1 * 60_000)).toBe("1 minute");
  });

  it("formats exact-hour durations without minutes", () => {
    expect(formatRelativeDuration(2 * 60 * 60_000)).toBe("2 hours");
    expect(formatRelativeDuration(1 * 60 * 60_000)).toBe("1 hour");
  });

  it("formats mixed hour+minute durations", () => {
    expect(formatRelativeDuration(3 * 60 * 60_000 + 20 * 60_000)).toBe("3h 20m");
  });

  it("handles sub-minute durations gracefully", () => {
    expect(formatRelativeDuration(30_000)).toBe("less than a minute");
  });
});

describe("describeTransition", () => {
  it("combines UTC clock, local clock, and relative time into one readable string", () => {
    const now = new Date("2026-08-16T00:45:00.000Z");
    const transition = { at: new Date("2026-08-16T01:00:00.000Z"), toTier: "peak" };
    const description = describeTransition(transition, now, "UTC");
    expect(description).toContain("peak");
    expect(description).toContain("01:00 UTC");
    expect(description).toContain("in 15 minutes");
  });

  it("says 'just now' for a transition at or before the reference time", () => {
    const now = new Date("2026-08-16T01:00:00.000Z");
    const transition = { at: new Date("2026-08-16T01:00:00.000Z"), toTier: "peak" };
    expect(describeTransition(transition, now, "UTC")).toContain("just now");
  });
});
