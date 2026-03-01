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
    it("returns 1 leg for same-day booking", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-01T20:00:00.000Z");

      expect(calculateLegCount("DAY", startDate, endDate)).toBe(1);
    });

    it("returns 2 legs for 2-day booking (non-midnight end)", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-02T20:00:00.000Z");

      expect(calculateLegCount("DAY", startDate, endDate)).toBe(2);
    });

    it("returns 2 legs when endDate is midnight UTC (boundary case)", () => {
      // This is the key case: endDate at midnight should NOT count as an extra day
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-03T00:00:00.000Z"); // Midnight

      // With midnight adjustment: 2026-03-03T00:00:00Z - 1ms = 2026-03-02T23:59:59.999Z
      // eachDayOfInterval(March 1 to March 2) = 2 days
      expect(calculateLegCount("DAY", startDate, endDate)).toBe(2);
    });

    it("returns 3 legs for 3-day booking", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-03T20:00:00.000Z");

      expect(calculateLegCount("DAY", startDate, endDate)).toBe(3);
    });

    it("returns 1 leg when adjusted endDate would be before startDate", () => {
      // Same day, endDate at midnight of the same day
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-01T00:00:00.000Z"); // Midnight same day (before startDate)

      // Adjustment would make endDate < startDate, so we use startDate as endDate
      expect(calculateLegCount("DAY", startDate, endDate)).toBe(1);
    });
  });

  describe("NIGHT bookings", () => {
    it("returns 1 leg for single night", () => {
      const startDate = new Date("2026-03-01T23:00:00.000Z");
      const endDate = new Date("2026-03-02T05:00:00.000Z");

      expect(calculateLegCount("NIGHT", startDate, endDate)).toBe(1);
    });

    it("returns 2 legs for 2 nights (over 24 hours)", () => {
      const startDate = new Date("2026-03-01T23:00:00.000Z");
      const endDate = new Date("2026-03-03T05:00:00.000Z"); // ~30 hours

      expect(calculateLegCount("NIGHT", startDate, endDate)).toBe(2);
    });

    it("handles midnight boundary for nights", () => {
      const startDate = new Date("2026-03-01T23:00:00.000Z");
      const endDate = new Date("2026-03-03T00:00:00.000Z"); // Midnight

      // With adjustment: 25 hours -> ceil(25/24) = 2 legs
      expect(calculateLegCount("NIGHT", startDate, endDate)).toBe(2);
    });
  });

  describe("FULL_DAY bookings", () => {
    it("returns 1 leg for less than 24 hours", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-02T07:00:00.000Z"); // 23 hours

      expect(calculateLegCount("FULL_DAY", startDate, endDate)).toBe(1);
    });

    it("returns 2 legs for over 24 hours", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-02T10:00:00.000Z"); // 26 hours

      expect(calculateLegCount("FULL_DAY", startDate, endDate)).toBe(2);
    });

    it("returns 2 legs for exactly 48 hours", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-03T08:00:00.000Z"); // 48 hours

      expect(calculateLegCount("FULL_DAY", startDate, endDate)).toBe(2);
    });

    it("handles midnight boundary for full day", () => {
      const startDate = new Date("2026-03-01T08:00:00.000Z");
      const endDate = new Date("2026-03-03T00:00:00.000Z"); // Midnight

      // With adjustment: ~40 hours -> ceil(40/24) = 2 legs
      expect(calculateLegCount("FULL_DAY", startDate, endDate)).toBe(2);
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
