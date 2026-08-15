import { describe, expect, it } from "vitest";
import { computeNotificationEvents } from "../notifications.js";
import { deepseekPricingSchedule } from "../schedules/deepseek.js";
import { DEFAULT_NOTIFICATION_CONFIG } from "../types.js";

const schedule = deepseekPricingSchedule;

describe("computeNotificationEvents — pre-peak notification", () => {
  it("fires a pre-peak event exactly at the configured lead time before peak starts", () => {
    const now = new Date("2026-08-16T00:45:00.000Z"); // 15 min before 01:00 UTC peak start
    const { events, updatedRecord } = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now,
      config: DEFAULT_NOTIFICATION_CONFIG,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("pre-peak");
    expect(events[0]!.message).toBe(
      "DeepSeek peak pricing starts in 15 minutes. Continue with DeepSeek or hand off to another provider?",
    );
    expect(updatedRecord?.preNotified).toBe(true);
    expect(updatedRecord?.startNotified).toBe(false);
  });

  it("does not fire a pre-peak event before the lead-time window opens", () => {
    const now = new Date("2026-08-16T00:30:00.000Z"); // 30 min before, lead time is 15
    const { events } = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now,
      config: DEFAULT_NOTIFICATION_CONFIG,
    });
    expect(events).toEqual([]);
  });

  it("respects a configurable lead time other than the default", () => {
    const now = new Date("2026-08-16T00:30:00.000Z"); // 30 min before
    const { events } = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now,
      config: { leadTimeMinutes: 30 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("pre-peak");
  });
});

describe("computeNotificationEvents — peak-start notification", () => {
  it("fires a peak-started event exactly at the transition instant", () => {
    const now = new Date("2026-08-16T01:00:00.000Z");
    const { events, updatedRecord } = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now,
      config: DEFAULT_NOTIFICATION_CONFIG,
    });
    const startedEvent = events.find((e) => e.kind === "peak-started");
    expect(startedEvent?.message).toBe(
      "DeepSeek is now in peak pricing. Current session can continue, or you can hand it off to another available provider.",
    );
    expect(updatedRecord?.startNotified).toBe(true);
  });

  it("does not fire a peak-started event before the transition", () => {
    const now = new Date("2026-08-16T00:59:00.000Z");
    const { events } = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now,
      config: DEFAULT_NOTIFICATION_CONFIG,
    });
    expect(events.some((e) => e.kind === "peak-started")).toBe(false);
  });
});

describe("computeNotificationEvents — no duplicate notifications within the same tracked transition", () => {
  it("does not re-fire pre-peak once already notified, even on a later check before the transition", () => {
    const first = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now: new Date("2026-08-16T00:50:00.000Z"),
      config: DEFAULT_NOTIFICATION_CONFIG,
    });
    expect(first.events).toHaveLength(1);

    const second = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now: new Date("2026-08-16T00:55:00.000Z"),
      config: DEFAULT_NOTIFICATION_CONFIG,
      priorRecord: first.updatedRecord,
    });
    expect(second.events).toEqual([]);
  });

  it("fires pre-peak then peak-started exactly once each across a sequence of checks, then rolls over for the next day's cycle", () => {
    let record = undefined as ReturnType<typeof computeNotificationEvents>["updatedRecord"];
    const allEvents: string[] = [];

    const checkpoints = [
      "2026-08-16T00:30:00.000Z", // before lead time
      "2026-08-16T00:50:00.000Z", // pre-peak fires
      "2026-08-16T00:58:00.000Z", // no dup
      "2026-08-16T01:00:00.000Z", // peak-started fires
      "2026-08-16T02:00:00.000Z", // no dup (still tracking the 04:00 off-peak transition, no events for that)
    ];
    for (const iso of checkpoints) {
      const result = computeNotificationEvents({
        schedule,
        providerDisplayName: "DeepSeek",
        now: new Date(iso),
        config: DEFAULT_NOTIFICATION_CONFIG,
        priorRecord: record,
      });
      allEvents.push(...result.events.map((e) => e.kind));
      record = result.updatedRecord;
    }

    expect(allEvents).toEqual(["pre-peak", "peak-started"]);

    // Next day's cycle: once the tracked transition (off-peak at 04:00) has
    // passed, the following check should track the *next* peak transition
    // (06:00) fresh, and pre-peak can fire again for it.
    const nextCycle = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now: new Date("2026-08-16T05:50:00.000Z"),
      config: DEFAULT_NOTIFICATION_CONFIG,
      priorRecord: record,
    });
    expect(nextCycle.events.map((e) => e.kind)).toEqual(["pre-peak"]);
  });
});

describe("computeNotificationEvents — only peak-bound transitions produce notifications", () => {
  it("produces no events when the next tracked transition is INTO off-peak", () => {
    const now = new Date("2026-08-16T01:30:00.000Z"); // inside peak window, next transition is off-peak at 04:00
    const { events } = computeNotificationEvents({
      schedule,
      providerDisplayName: "DeepSeek",
      now,
      config: DEFAULT_NOTIFICATION_CONFIG,
    });
    expect(events).toEqual([]);
  });
});
