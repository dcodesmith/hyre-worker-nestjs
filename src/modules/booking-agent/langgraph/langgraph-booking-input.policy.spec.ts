import { describe, expect, it } from "vitest";
import { parsePublicBookingInput } from "./langgraph-booking-input.policy";

const validGuestInput = {
  carId: "car_1",
  startDate: new Date("2026-03-01T09:00:00.000Z"),
  endDate: new Date("2026-03-01T21:00:00.000Z"),
  pickupAddress: "Victoria Island",
  bookingType: "DAY" as const,
  pickupTime: "9:00 AM",
  includeSecurityDetail: false,
  requiresFullTank: false,
  useCredits: 0,
  expectedTotalAmount: "150000",
  guestEmail: "whatsapp.2348012345678@tripdly.com",
  guestName: "Test User",
  guestPhone: "+2348012345678",
  sameLocation: false as const,
  dropOffAddress: "Lekki",
};

describe("parsePublicBookingInput", () => {
  it("accepts a guest payload that matches the public booking schema", () => {
    const result = parsePublicBookingInput(validGuestInput, false);
    expect(result.ok).toBe(true);
  });

  it("rejects airport pickup without a flight number", () => {
    const result = parsePublicBookingInput(
      {
        ...validGuestInput,
        bookingType: "AIRPORT_PICKUP",
        sameLocation: false,
        dropOffAddress: "Lekki",
      },
      false,
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.issues.join(" ")).toContain("Flight number");
    }
  });

  it("rejects authenticated payloads that still include invalid pickup time", () => {
    const {
      guestEmail: _email,
      guestName: _name,
      guestPhone: _phone,
      ...authenticated
    } = validGuestInput;
    const result = parsePublicBookingInput(
      {
        ...authenticated,
        pickupTime: "09:00",
      },
      true,
    );

    expect(result.ok).toBe(false);
  });
});
