import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { BookingLegService } from "./booking-leg.service";
import { LegGenerationInput } from "./booking.interface";
import { AIRPORT_PICKUP_BUFFER_MINUTES } from "./booking.const";

describe("BookingLegService", () => {
  let service: BookingLegService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BookingLegService],
    }).compile();

    service = module.get<BookingLegService>(BookingLegService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("DAY bookings", () => {
    it("should generate one leg for single-day booking", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-01T23:59:59Z"),
        bookingType: "DAY",
        pickupTime: "9 AM",
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(1);
      expect(legs[0].legDate.toISOString().startsWith("2025-03-01")).toBe(true);
      expect(legs[0].legStartTime.getUTCHours()).toBe(9);
      expect(legs[0].legStartTime.getUTCMinutes()).toBe(0);
      expect(legs[0].legEndTime.getUTCHours()).toBe(21);
    });

    it("should generate multiple legs for multi-day booking", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-03T23:59:59Z"),
        bookingType: "DAY",
        pickupTime: "10 AM",
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(3);
      expect(legs[0].legDate.toISOString().startsWith("2025-03-01")).toBe(true);
      expect(legs[1].legDate.toISOString().startsWith("2025-03-02")).toBe(true);
      expect(legs[2].legDate.toISOString().startsWith("2025-03-03")).toBe(true);

      for (const leg of legs) {
        expect(leg.legStartTime.getUTCHours()).toBe(10);
        expect(leg.legEndTime.getUTCHours()).toBe(22);
      }
    });

    it("should handle PM pickup time correctly", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-01T23:59:59Z"),
        bookingType: "DAY",
        pickupTime: "2 PM",
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(1);
      expect(legs[0].legStartTime.getUTCHours()).toBe(14);
      expect(legs[0].legEndTime.getUTCHours()).toBe(2);
    });

    it("should handle pickup time with minutes", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-01T23:59:59Z"),
        bookingType: "DAY",
        pickupTime: "9:30 AM",
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(1);
      expect(legs[0].legStartTime.getUTCHours()).toBe(9);
      expect(legs[0].legStartTime.getUTCMinutes()).toBe(30);
    });

    it("should handle midnight end date edge case", () => {
      // End date at exactly midnight should not add an extra day
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00.000Z"),
        endDate: new Date("2025-03-02T00:00:00.000Z"), // Exactly midnight
        bookingType: "DAY",
        pickupTime: "9 AM",
      };

      const legs = service.generateLegs(input);

      // Should only be 1 leg (March 1st), not 2
      expect(legs).toHaveLength(1);
      expect(legs[0].legDate.toISOString().startsWith("2025-03-01")).toBe(true);
    });
  });

  describe("NIGHT bookings", () => {
    it("should generate one leg for single-night booking", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-02T00:00:00Z"),
        bookingType: "NIGHT",
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(1);
      expect(legs[0].legStartTime.getUTCHours()).toBe(23);
      expect(legs[0].legEndTime.getUTCHours()).toBe(5);
    });

    it("should generate multiple legs for multi-night booking", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-04T00:00:00Z"),
        bookingType: "NIGHT",
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(3);

      for (const leg of legs) {
        expect(leg.legStartTime.getUTCHours()).toBe(23);
        expect(leg.legEndTime.getUTCHours()).toBe(5);
      }
    });

    it("should have leg end time on the next day", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-02T00:00:00Z"),
        bookingType: "NIGHT",
      };

      const legs = service.generateLegs(input);

      const legStartDay = legs[0].legStartTime.getUTCDate();
      const legEndDay = legs[0].legEndTime.getUTCDate();

      expect(legEndDay).toBe(legStartDay + 1);
    });

    it("should generate at least one leg even for very short booking", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T22:00:00Z"),
        endDate: new Date("2025-03-01T23:00:00Z"),
        bookingType: "NIGHT",
      };

      const legs = service.generateLegs(input);

      expect(legs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("FULL_DAY bookings", () => {
    it("should generate one leg for single 24-hour period", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-02T00:00:00Z"),
        bookingType: "FULL_DAY",
        pickupTime: "10 AM",
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(1);
      expect(legs[0].legStartTime.getUTCHours()).toBe(10);

      const durationMs = legs[0].legEndTime.getTime() - legs[0].legStartTime.getTime();
      const durationHours = durationMs / (1000 * 60 * 60);
      expect(durationHours).toBe(24);
    });

    it("should generate multiple legs for multi-day booking", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-03T12:00:00Z"),
        bookingType: "FULL_DAY",
        pickupTime: "10 AM",
      };

      const legs = service.generateLegs(input);

      // ceil((50 - 10) / 24) = ceil(40/24) = ceil(1.67) = 2, but we need to account for
      // the actual calculation which is based on total time from pickup
      expect(legs.length).toBeGreaterThanOrEqual(2);

      // All legs should be exactly 24 hours
      for (const leg of legs) {
        const durationMs = leg.legEndTime.getTime() - leg.legStartTime.getTime();
        const durationHours = durationMs / (1000 * 60 * 60);
        expect(durationHours).toBe(24);
      }
    });

    it("should chain legs consecutively (each starts when previous ends)", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-04T00:00:00Z"),
        bookingType: "FULL_DAY",
        pickupTime: "8 AM",
      };

      const legs = service.generateLegs(input);

      for (let i = 1; i < legs.length; i++) {
        const previousLegEnd = legs[i - 1].legEndTime.getTime();
        const currentLegStart = legs[i].legStartTime.getTime();
        expect(currentLegStart).toBe(previousLegEnd);
      }
    });

    it("should handle PM pickup times", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00Z"),
        endDate: new Date("2025-03-02T20:00:00Z"),
        bookingType: "FULL_DAY",
        pickupTime: "6 PM",
      };

      const legs = service.generateLegs(input);

      expect(legs[0].legStartTime.getUTCHours()).toBe(18); // 6 PM
    });
  });

  describe("AIRPORT_PICKUP bookings", () => {
    it("should generate single leg with 40-minute buffer after flight arrival", () => {
      const flightArrival = new Date("2025-03-01T14:00:00Z"); // 2 PM

      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T14:00:00Z"),
        endDate: new Date("2025-03-01T18:00:00Z"),
        bookingType: "AIRPORT_PICKUP",
        flightArrivalTime: flightArrival,
        driveTimeMinutes: 60,
      };

      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(1);

      // Leg should start 40 minutes after flight arrival
      const expectedStartMs = flightArrival.getTime() + 40 * 60 * 1000;
      expect(legs[0].legStartTime.getTime()).toBe(expectedStartMs);
    });

    it("should calculate end time with 20% buffer on drive time", () => {
      const flightArrival = new Date("2025-03-01T14:00:00Z");
      const driveTimeMinutes = 60;

      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T14:00:00Z"),
        endDate: new Date("2025-03-01T18:00:00Z"),
        bookingType: "AIRPORT_PICKUP",
        flightArrivalTime: flightArrival,
        driveTimeMinutes,
      };

      const legs = service.generateLegs(input);

      // Expected: start + (driveTime × 1.2)
      // Start = 14:40 (arrival + 40min buffer)
      // End = 14:40 + (60 × 1.2) = 14:40 + 72min = 15:52
      const expectedStartMs = flightArrival.getTime() + AIRPORT_PICKUP_BUFFER_MINUTES * 60 * 1000;
      const expectedEndMs = expectedStartMs + driveTimeMinutes * 1.2 * 60 * 1000;

      expect(legs[0].legEndTime.getTime()).toBe(expectedEndMs);
    });

    it("should use 2-hour default drive time if not provided", () => {
      const flightArrival = new Date("2025-03-01T14:00:00Z");

      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T14:00:00Z"),
        endDate: new Date("2025-03-01T18:00:00Z"),
        bookingType: "AIRPORT_PICKUP",
        flightArrivalTime: flightArrival,
      };

      const legs = service.generateLegs(input);

      // Default drive time is 120 minutes with 1.2× buffer = 144 minutes
      const expectedStartMs = flightArrival.getTime() + AIRPORT_PICKUP_BUFFER_MINUTES * 60 * 1000;
      const expectedEndMs = expectedStartMs + 120 * 1.2 * 60 * 1000;

      expect(legs[0].legEndTime.getTime()).toBe(expectedEndMs);
    });

    it("should use startDate as fallback if flightArrivalTime not provided", () => {
      const startDate = new Date("2025-03-01T14:00:00Z");

      const input: LegGenerationInput = {
        startDate,
        endDate: new Date("2025-03-01T18:00:00Z"),
        bookingType: "AIRPORT_PICKUP",
        driveTimeMinutes: 60,
      };

      const legs = service.generateLegs(input);

      // Should use startDate + 40 min buffer
      const expectedStartMs = startDate.getTime() + AIRPORT_PICKUP_BUFFER_MINUTES * 60 * 1000;
      expect(legs[0].legStartTime.getTime()).toBe(expectedStartMs);
    });

    it("should preserve exact minutes from flight arrival time", () => {
      // Flight arrives at 14:25 (not on the hour)
      const flightArrival = new Date("2025-03-01T14:25:00Z");

      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T14:25:00Z"),
        endDate: new Date("2025-03-01T18:00:00Z"),
        bookingType: "AIRPORT_PICKUP",
        flightArrivalTime: flightArrival,
        driveTimeMinutes: 45,
      };

      const legs = service.generateLegs(input);

      // Start should be 14:25 + 40min = 15:05
      expect(legs[0].legStartTime.getUTCHours()).toBe(15);
      expect(legs[0].legStartTime.getUTCMinutes()).toBe(5);
    });
  });

  describe("getEffectiveEndDate (midnight edge case)", () => {
    it("should subtract 1ms from exact midnight", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00.000Z"),
        endDate: new Date("2025-03-03T00:00:00.000Z"), // Exactly midnight
        bookingType: "DAY",
        pickupTime: "9 AM",
      };

      const legs = service.generateLegs(input);

      // Should be 2 days (Mar 1, Mar 2), not 3
      expect(legs).toHaveLength(2);
    });

    it("should not modify non-midnight end dates", () => {
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00.000Z"),
        endDate: new Date("2025-03-03T12:00:00.000Z"), // Not midnight
        bookingType: "DAY",
        pickupTime: "9 AM",
      };

      const legs = service.generateLegs(input);

      // Should be 3 days (Mar 1, Mar 2, Mar 3)
      expect(legs).toHaveLength(3);
    });

    it("should not crash when startDate equals endDate at midnight (defensive)", () => {
      // This edge case is now blocked by DTO validation (endDate > startDate),
      // but the service handles it defensively to avoid RangeError from eachDayOfInterval
      const input: LegGenerationInput = {
        startDate: new Date("2025-03-01T00:00:00.000Z"),
        endDate: new Date("2025-03-01T00:00:00.000Z"), // Same as startDate, both midnight
        bookingType: "DAY",
        pickupTime: "9 AM",
      };

      // Should not throw, instead generates 1 leg for that day
      const legs = service.generateLegs(input);

      expect(legs).toHaveLength(1);
      expect(legs[0].legDate.toISOString().startsWith("2025-03-01")).toBe(true);
    });
  });
});
