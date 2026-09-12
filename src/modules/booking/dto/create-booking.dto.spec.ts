import { describe, expect, it } from "vitest";
import { createBookingSchema, createGuestBookingSchema } from "./create-booking.dto";
import { pricingPreviewBodySchema } from "./pricing-preview.dto";

function expectRejectedUnknownField(
  result: { success: boolean; error?: { issues: unknown } },
  field: string,
) {
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).toContain(field);
}

describe("CreateBookingSchema", () => {
  const validBaseBooking = {
    carId: "car-123",
    startDate: new Date("2025-02-01T09:00:00Z"),
    endDate: new Date("2025-02-01T21:00:00Z"),
    pickupAddress: "Lagos Airport",
    bookingType: "DAY" as const,
    pickupTime: "9 AM",
    sameLocation: true as const,
    addonIds: [],
    requiresFullTank: false,
    useCredits: 0,
    expectedTotalAmount: "10000",
  };

  describe("AIRPORT_PICKUP validation", () => {
    it("should reject AIRPORT_PICKUP with sameLocation=true", () => {
      const booking = {
        ...validBaseBooking,
        bookingType: "AIRPORT_PICKUP" as const,
        flightNumber: "BA74",
        pickupTime: "9 AM",
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
        pickupTime: "9 AM",
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

  describe("callbackUrl validation", () => {
    it("rejects unsafe callback URL protocols", () => {
      const booking = {
        ...validBaseBooking,
        callbackUrl: "javascript:alert(1)",
      };

      const result = createBookingSchema.safeParse(booking);
      expect(result.success).toBe(false);
    });

    it("accepts mobile deep-link callback URLs", () => {
      const booking = {
        ...validBaseBooking,
        callbackUrl: "hyreapp://payments/complete?tx=abc123",
      };

      const result = createBookingSchema.safeParse(booking);
      expect(result.success).toBe(true);
    });
  });

  describe("expectedTotalAmount validation", () => {
    it("requires a non-negative decimal string", () => {
      expect(
        createBookingSchema.safeParse({
          ...validBaseBooking,
          expectedTotalAmount: undefined,
        }).success,
      ).toBe(false);
      expect(
        createBookingSchema.safeParse({
          ...validBaseBooking,
          expectedTotalAmount: "-1",
        }).success,
      ).toBe(false);
      expect(
        createBookingSchema.safeParse({
          ...validBaseBooking,
          expectedTotalAmount: "1e3",
        }).success,
      ).toBe(false);
      expect(
        createBookingSchema.safeParse({
          ...validBaseBooking,
          expectedTotalAmount: "1000.50",
        }).success,
      ).toBe(true);
    });
  });

  describe("referral credits validation", () => {
    it("accepts currency precision and rejects smaller fractions", () => {
      expect(
        createBookingSchema.safeParse({ ...validBaseBooking, useCredits: 1234.56 }).success,
      ).toBe(true);
      expect(
        createBookingSchema.safeParse({ ...validBaseBooking, useCredits: 1234.567 }).success,
      ).toBe(false);
      expect(
        pricingPreviewBodySchema.safeParse({
          carId: "car-123",
          bookingType: "DAY",
          startDate: validBaseBooking.startDate,
          endDate: validBaseBooking.endDate,
          pickupTime: "9 AM",
          useCredits: 1234.567,
        }).success,
      ).toBe(false);
    });
  });

  describe("addonIds validation", () => {
    const addonIdA = "cmh0k0v000000qjah7x2p8k1a";
    const addonIdB = "cmh0k0v000000qjah7x2p8k1b";

    it("defaults omitted addonIds to an empty list", () => {
      const { addonIds: _addonIds, ...withoutAddonIds } = validBaseBooking;
      const result = createBookingSchema.safeParse(withoutAddonIds);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.addonIds).toEqual([]);
      }
    });

    it("accepts unique CUID addon IDs", () => {
      const result = createBookingSchema.safeParse({
        ...validBaseBooking,
        addonIds: [addonIdA, addonIdB],
      });

      expect(result.success).toBe(true);
    });

    it("rejects duplicate addon IDs", () => {
      const result = createBookingSchema.safeParse({
        ...validBaseBooking,
        addonIds: [addonIdA, addonIdA],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message === "Add-on IDs must be unique"),
        ).toBe(true);
      }
    });

    it("rejects more than 10 add-ons", () => {
      const ids = Array.from(
        { length: 11 },
        (_, index) => `cmh0k0v000000qjah7x2p8k${index.toString().padStart(2, "0")}`,
      );
      const result = createBookingSchema.safeParse({
        ...validBaseBooking,
        addonIds: ids,
      });

      expect(result.success).toBe(false);
    });

    it("rejects non-CUID addon IDs", () => {
      const result = createBookingSchema.safeParse({
        ...validBaseBooking,
        addonIds: ["not-a-cuid"],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("unknown fields", () => {
    it("rejects legacy includeSecurityDetail on create booking instead of stripping it", () => {
      expectRejectedUnknownField(
        createBookingSchema.safeParse({
          ...validBaseBooking,
          includeSecurityDetail: true,
        }),
        "includeSecurityDetail",
      );
    });

    it("rejects other unknown create-booking fields", () => {
      expectRejectedUnknownField(
        createBookingSchema.safeParse({
          ...validBaseBooking,
          extraField: "nope",
        }),
        "extraField",
      );
    });
  });

  describe("pricing preview extra fields", () => {
    it("tolerates extra full-form fields such as pickupAddress and sameLocation", () => {
      const result = pricingPreviewBodySchema.safeParse({
        carId: "car-123",
        bookingType: "DAY",
        startDate: validBaseBooking.startDate,
        endDate: validBaseBooking.endDate,
        pickupTime: "9 AM",
        pickupAddress: validBaseBooking.pickupAddress,
        sameLocation: true,
      });

      expect(result.success).toBe(true);
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
    addonIds: [],
    requiresFullTank: false,
    useCredits: 0,
    expectedTotalAmount: "10000",
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
        pickupTime: "9 AM",
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
        pickupTime: "9 AM",
        sameLocation: false as const,
        dropOffAddress: "Victoria Island, Lagos",
      };

      const result = createGuestBookingSchema.safeParse(booking);

      expect(result.success).toBe(true);
    });
  });

  it("rejects legacy includeSecurityDetail instead of stripping it", () => {
    expectRejectedUnknownField(
      createGuestBookingSchema.safeParse({
        ...validGuestBooking,
        includeSecurityDetail: true,
      }),
      "includeSecurityDetail",
    );
  });
});
