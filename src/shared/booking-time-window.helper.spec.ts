import { describe, expect, it } from "vitest";
import { normalizeBookingTimeWindow } from "./booking-time-window.helper";

describe("normalizeBookingTimeWindow", () => {
  it("normalizes DAY windows with end date day preserved", () => {
    const { startDate, endDate } = normalizeBookingTimeWindow({
      bookingType: "DAY",
      startDate: new Date("2026-03-03T00:00:00.000Z"),
      endDate: new Date("2026-03-05T00:00:00.000Z"),
      pickupTime: "10 AM",
    });

    expect(startDate.toISOString()).toBe("2026-03-03T10:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-03-05T22:00:00.000Z");
  });

  it("normalizes FULL_DAY windows to 24-hour spans", () => {
    const { startDate, endDate } = normalizeBookingTimeWindow({
      bookingType: "FULL_DAY",
      startDate: new Date("2026-03-03T00:00:00.000Z"),
      endDate: new Date("2026-03-05T00:00:00.000Z"),
      pickupTime: "10 AM",
    });

    expect(startDate.toISOString()).toBe("2026-03-03T10:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-03-05T10:00:00.000Z");
  });

  it("normalizes NIGHT windows to fixed 11 PM - 5 AM", () => {
    const { startDate, endDate } = normalizeBookingTimeWindow({
      bookingType: "NIGHT",
      startDate: new Date("2026-03-03T00:00:00.000Z"),
      endDate: new Date("2026-03-04T00:00:00.000Z"),
    });

    expect(startDate.toISOString()).toBe("2026-03-03T23:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-03-04T05:00:00.000Z");
  });
});
