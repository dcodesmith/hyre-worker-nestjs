import { describe, expect, it } from "vitest";
import type { NormalisedBookingLegDetails } from "../types";
import { bookingLegToTripCardData, firstNameFrom } from "./booking-email-helpers";

describe("booking-email-helpers", () => {
  describe("firstNameFrom", () => {
    it("returns the first token for multi-part names", () => {
      expect(firstNameFrom("Alex Johnson")).toBe("Alex");
    });

    it("returns input unchanged when no spaces exist", () => {
      expect(firstNameFrom("Cher")).toBe("Cher");
    });

    it("handles leading and repeated whitespace", () => {
      expect(firstNameFrom("  Alex   Johnson ")).toBe("Alex");
    });
  });

  describe("bookingLegToTripCardData", () => {
    it("maps a booking leg to the trip-card fields only", () => {
      const leg: NormalisedBookingLegDetails = {
        bookingLegId: "leg-1",
        bookingId: "booking-123",
        customerName: "Alex Johnson",
        chauffeurName: "Sam Driver",
        legDate: "Mon, Apr 21, 2026",
        legStartTime: "Mon, Apr 21, 2026 · 2:00 PM",
        legEndTime: "Wed, Apr 23, 2026 · 10:00 AM",
        carName: "Mercedes-Benz S-Class (2024)",
        pickupLocation: "MMIA, Lagos",
        returnLocation: "Eko Hotels, VI",
      };

      expect(bookingLegToTripCardData(leg)).toEqual({
        bookingReference: "booking-123",
        carName: "Mercedes-Benz S-Class (2024)",
        pickupLocation: "MMIA, Lagos",
        returnLocation: "Eko Hotels, VI",
        startDate: "Mon, Apr 21, 2026 · 2:00 PM",
        endDate: "Wed, Apr 23, 2026 · 10:00 AM",
        totalAmount: "—",
      });
    });
  });
});
