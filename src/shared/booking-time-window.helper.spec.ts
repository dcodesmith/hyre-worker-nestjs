import { describe, expect, it } from "vitest";
import { normalizeBookingTimeWindow, toApiPickupTime } from "./booking-time-window.helper";

describe("normalizeBookingTimeWindow", () => {
  it("defaults DAY pickup time to 7:00 AM when omitted", () => {
    const { startDate, endDate } = normalizeBookingTimeWindow({
      bookingType: "DAY",
      startDate: new Date("2026-03-03T00:00:00.000Z"),
      endDate: new Date("2026-03-03T00:00:00.000Z"),
    });

    expect(startDate.toISOString()).toBe("2026-03-03T07:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-03-03T19:00:00.000Z");
  });

  it("defaults FULL_DAY pickup time to 6:00 AM when omitted", () => {
    const { startDate, endDate } = normalizeBookingTimeWindow({
      bookingType: "FULL_DAY",
      startDate: new Date("2026-03-03T00:00:00.000Z"),
      endDate: new Date("2026-03-04T00:00:00.000Z"),
    });

    expect(startDate.toISOString()).toBe("2026-03-03T06:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-03-04T06:00:00.000Z");
  });

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

  it("rolls NIGHT end date to next day when from and to are the same date", () => {
    const { startDate, endDate } = normalizeBookingTimeWindow({
      bookingType: "NIGHT",
      startDate: new Date("2026-03-03T00:00:00.000Z"),
      endDate: new Date("2026-03-03T00:00:00.000Z"),
    });

    expect(startDate.toISOString()).toBe("2026-03-03T23:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-03-04T05:00:00.000Z");
  });
});

describe("toApiPickupTime", () => {
  it("converts 24-hour times to the public booking DTO format", () => {
    expect(toApiPickupTime("09:00")).toBe("9 AM");
    expect(toApiPickupTime("21:30")).toBe("9:30 PM");
    expect(toApiPickupTime("00:00")).toBe("12 AM");
  });

  it("leaves already-valid 12-hour times unchanged", () => {
    expect(toApiPickupTime("9:00 AM")).toBe("9:00 AM");
    expect(toApiPickupTime("7 AM")).toBe("7 AM");
  });
});
