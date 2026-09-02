import { describe, expect, it } from "vitest";
import { calculateLegCount } from "./booking.helper";

describe("calculateLegCount", () => {
  describe("AIRPORT_PICKUP", () => {
    it("always returns 1 leg", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-01T12:00:00.000Z");

      expect(calculateLegCount("AIRPORT_PICKUP", startDate, endDate)).toBe(1);
    });
  });

  describe("DAY bookings", () => {
    it.each([
      {
        name: "same-day booking",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-01T20:00:00.000Z",
        expected: 1,
      },
      {
        name: "2-day booking (non-midnight end)",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-02T20:00:00.000Z",
        expected: 2,
      },
      {
        name: "midnight UTC endDate boundary",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-03T00:00:00.000Z",
        expected: 2,
      },
      {
        name: "3-day booking",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-03T20:00:00.000Z",
        expected: 3,
      },
      {
        name: "adjusted endDate before startDate",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-01T00:00:00.000Z",
        expected: 1,
      },
    ])("returns $expected leg(s) for $name", ({ startDate, endDate, expected }) => {
      expect(calculateLegCount("DAY", new Date(startDate), new Date(endDate))).toBe(expected);
    });
  });

  describe("NIGHT bookings", () => {
    it.each([
      {
        name: "single night",
        startDate: "2026-03-01T23:00:00.000Z",
        endDate: "2026-03-02T05:00:00.000Z",
        expected: 1,
      },
      {
        name: "2 nights (over 24 hours)",
        startDate: "2026-03-01T23:00:00.000Z",
        endDate: "2026-03-03T05:00:00.000Z",
        expected: 2,
      },
      {
        name: "midnight boundary",
        startDate: "2026-03-01T23:00:00.000Z",
        endDate: "2026-03-03T00:00:00.000Z",
        expected: 2,
      },
    ])("returns $expected leg(s) for $name", ({ startDate, endDate, expected }) => {
      expect(calculateLegCount("NIGHT", new Date(startDate), new Date(endDate))).toBe(expected);
    });
  });

  describe("FULL_DAY bookings", () => {
    it.each([
      {
        name: "less than 24 hours",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-02T07:00:00.000Z",
        expected: 1,
      },
      {
        name: "over 24 hours",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-02T10:00:00.000Z",
        expected: 2,
      },
      {
        name: "exactly 48 hours",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-03T08:00:00.000Z",
        expected: 2,
      },
      {
        name: "midnight boundary",
        startDate: "2026-03-01T08:00:00.000Z",
        endDate: "2026-03-03T00:00:00.000Z",
        expected: 2,
      },
    ])("returns $expected leg(s) for $name", ({ startDate, endDate, expected }) => {
      expect(calculateLegCount("FULL_DAY", new Date(startDate), new Date(endDate))).toBe(expected);
    });
  });

  describe("edge cases", () => {
    it("returns minimum 1 leg even for very short duration", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-01T08:01:00.000Z"); // 1 minute

      expect(calculateLegCount("DAY", startDate, endDate)).toBe(1);
      expect(calculateLegCount("NIGHT", startDate, endDate)).toBe(1);
      expect(calculateLegCount("FULL_DAY", startDate, endDate)).toBe(1);
    });
  });
});
