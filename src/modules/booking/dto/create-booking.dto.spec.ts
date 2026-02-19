import { describe, expect, it } from "vitest";
import { createBookingSchema, createGuestBookingSchema } from "./create-booking.dto";

describe("CreateBookingSchema", () => {
  const validBaseBooking = {
    carId: "car-123",
    startDate: new Date("2025-02-01T09:00:00Z"),
    endDate: new Date("2025-02-01T21:00:00Z"),
    pickupAddress: "Lagos Airport",
    bookingType: "DAY" as const,
    pickupTime: "9 AM",
    sameLocation: true as const,
    includeSecurityDetail: false,
    requiresFullTank: false,
    useCredits: 0,
  };

  describe("AIRPORT_PICKUP validation", () => {
    it("should reject AIRPORT_PICKUP with sameLocation=true", () => {
      const booking = {
        ...validBaseBooking,
        bookingType: "AIRPORT_PICKUP" as const,
        flightNumber: "BA74",
        pickupTime: undefined,
        sameLocation: true as const,
      };

      const result = createBookingSchema.safeParse(booking);

      expect(result.success).toBe(false);
      if (!result.success) {
        const sameLocationError = result.error.issues.find((e) => e.path.includes("sameLocation"));
        expect(sameLocationError).toBeDefined();
        expect(sameLocationError?.message).toBe(
          "Airport pickup bookings require a different drop-off location",
        );
      }
    });

    it("should accept AIRPORT_PICKUP with sameLocation=false and dropOffAddress", () => {
      const booking = {
        ...validBaseBooking,
        bookingType: "AIRPORT_PICKUP" as const,
        flightNumber: "BA74",
        pickupTime: undefined,
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
      };

      const result = createBookingSchema.safeParse(booking);

      expect(result.success).toBe(true);
    });

    it("should require flightNumber for AIRPORT_PICKUP", () => {
      const booking = {
        ...validBaseBooking,
        bookingType: "AIRPORT_PICKUP" as const,
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
        // flightNumber missing
      };

      const result = createBookingSchema.safeParse(booking);

      expect(result.success).toBe(false);
      if (!result.success) {
        const flightError = result.error.issues.find((e) => e.path.includes("flightNumber"));
        expect(flightError).toBeDefined();
      }
    });
  });

  describe("DAY booking validation", () => {
    it("should accept DAY booking with sameLocation=true", () => {
      const result = createBookingSchema.safeParse(validBaseBooking);
      expect(result.success).toBe(true);
    });

    it("should accept DAY booking with sameLocation=false and dropOffAddress", () => {
      const booking = {
        ...validBaseBooking,
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
      };

      const result = createBookingSchema.safeParse(booking);
      expect(result.success).toBe(true);
    });

    it("should require pickupTime for DAY bookings", () => {
      const booking = {
        ...validBaseBooking,
        pickupTime: undefined,
      };

      const result = createBookingSchema.safeParse(booking);

      expect(result.success).toBe(false);
      if (!result.success) {
        const pickupTimeError = result.error.issues.find((e) => e.path.includes("pickupTime"));
        expect(pickupTimeError).toBeDefined();
      }
    });
  });

  describe("date validation", () => {
    it("should reject when endDate is before startDate", () => {
      const booking = {
        ...validBaseBooking,
        startDate: new Date("2025-02-01T21:00:00Z"),
        endDate: new Date("2025-02-01T09:00:00Z"),
      };

      const result = createBookingSchema.safeParse(booking);

      expect(result.success).toBe(false);
      if (!result.success) {
        const dateError = result.error.issues.find((e) => e.path.includes("endDate"));
        expect(dateError).toBeDefined();
        expect(dateError?.message).toBe("End date must be after start date");
      }
    });
  });
});

describe("CreateGuestBookingSchema", () => {
  const validGuestBooking = {
    carId: "car-123",
    startDate: new Date("2025-02-01T09:00:00Z"),
    endDate: new Date("2025-02-01T21:00:00Z"),
    pickupAddress: "Lagos Airport",
    bookingType: "DAY" as const,
    pickupTime: "9 AM",
    sameLocation: true as const,
    includeSecurityDetail: false,
    requiresFullTank: false,
    useCredits: 0,
    guestEmail: "guest@example.com",
    guestName: "Guest User",
    guestPhone: "08012345678",
  };

  describe("AIRPORT_PICKUP validation", () => {
    it("should reject AIRPORT_PICKUP with sameLocation=true for guest users", () => {
      const booking = {
        ...validGuestBooking,
        bookingType: "AIRPORT_PICKUP" as const,
        flightNumber: "BA74",
        pickupTime: undefined,
        sameLocation: true as const,
      };

      const result = createGuestBookingSchema.safeParse(booking);

      expect(result.success).toBe(false);
      if (!result.success) {
        const sameLocationError = result.error.issues.find((e) => e.path.includes("sameLocation"));
        expect(sameLocationError).toBeDefined();
        expect(sameLocationError?.message).toBe(
          "Airport pickup bookings require a different drop-off location",
        );
      }
    });

    it("should accept AIRPORT_PICKUP with sameLocation=false and dropOffAddress for guest users", () => {
      const booking = {
        ...validGuestBooking,
        bookingType: "AIRPORT_PICKUP" as const,
        flightNumber: "BA74",
        pickupTime: undefined,
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
      };

      const result = createGuestBookingSchema.safeParse(booking);

      expect(result.success).toBe(true);
    });
  });
});
