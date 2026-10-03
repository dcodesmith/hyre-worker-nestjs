import { describe, expect, it } from "vitest";
import type { VehicleSearchOption } from "../booking-agent.interface";
import { buildBookingInputFromDraft, buildGuestIdentity } from "./booking-orchestrator";

const guestIdentity = buildGuestIdentity("+447788263793", "Test User");
const selectedOption = {
  id: "car-1",
  make: "Mercedes-Benz",
  model: "GLE 350",
  name: "Mercedes-Benz GLE 350",
  color: "white",
  vehicleType: "SUV",
  serviceTier: "EXECUTIVE",
  imageUrl: null,
  rates: {
    day: 1200,
    night: 900,
    fullDay: 1800,
    airportPickup: 700,
  },
  estimatedTotalInclVat: 1828,
} satisfies VehicleSearchOption;

const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const selections = {
  addonIds: ["addon-wifi"],
  requiresFullTank: true,
  useCredits: 4000,
  expectedTotalAmount: "182800.00",
};

describe("buildBookingInputFromDraft", () => {
  it("requires explicit quote selections", () => {
    expect(() =>
      buildBookingInputFromDraft(
        {
          pickupDate: "2026-03-03",
          dropoffDate: "2026-03-03",
          bookingType: "DAY",
          pickupLocation: "Wheat Baker Hotel, Ikoyi",
          dropoffLocation: "Wheat Baker Hotel, Ikoyi",
        },
        selectedOption,
        guestIdentity,
      ),
    ).toThrow("Booking selections are required");
  });

  it("passes explicit pickupTime through to both normalized window and input payload", () => {
    const { input, normalizedStartDate, normalizedEndDate } = buildBookingInputFromDraft(
      {
        pickupDate: "2026-03-03",
        dropoffDate: "2026-03-03",
        bookingType: "DAY",
        pickupTime: "10:00",
        pickupLocation: "Wheat Baker Hotel, Ikoyi",
        dropoffLocation: "Wheat Baker Hotel, Ikoyi",
        notes: "Gate 4 pickup",
      },
      selectedOption,
      guestIdentity,
      selections,
    );

    expect(input.bookingType).toBe("DAY");
    expect(input.pickupTime).toBe("10 AM");
    expect(input.addonIds).toEqual(["addon-wifi"]);
    expect(input.requiresFullTank).toBe(true);
    expect(input.useCredits).toBe(4000);
    expect(input.expectedTotalAmount).toBe("182800.00");
    expect(input.specialRequests).toBe("Gate 4 pickup");
    expect(normalizedStartDate.getHours()).toBe(10);
    expect(normalizedEndDate.getTime() - normalizedStartDate.getTime()).toBe(TWELVE_HOURS);
  });

  it("uses shared DAY default pickup time when draft pickupTime is missing", () => {
    const { input, normalizedStartDate, normalizedEndDate } = buildBookingInputFromDraft(
      {
        pickupDate: "2026-03-03",
        dropoffDate: "2026-03-03",
        bookingType: "DAY",
        pickupLocation: "Wheat Baker Hotel, Ikoyi",
        dropoffLocation: "Wheat Baker Hotel, Ikoyi",
      },
      selectedOption,
      guestIdentity,
      { ...selections, addonIds: [], requiresFullTank: false, useCredits: 0 },
    );

    expect(input.pickupTime).toBe("7:00 AM");
    expect(input.addonIds).toEqual([]);
    expect(input.specialRequests).toBeUndefined();

    expect(normalizedStartDate.getHours()).toBe(7);
    expect(normalizedEndDate.getHours()).toBe(19);
    expect(normalizedEndDate.getTime() - normalizedStartDate.getTime()).toBe(TWELVE_HOURS);
  });

  it("uses the exact derived airport pickup and dropoff datetimes", () => {
    const pickupDateTime = "2026-03-01T14:40:00.000Z";
    const dropoffDateTime = "2026-03-01T15:54:00.000Z";
    const { input, normalizedStartDate, normalizedEndDate } = buildBookingInputFromDraft(
      {
        bookingType: "AIRPORT_PICKUP",
        pickupDate: "2026-03-01",
        pickupDateTime,
        dropoffDate: "2026-03-01",
        dropoffDateTime,
        pickupTime: "15:40",
        pickupLocation: "Murtala Muhammed International Airport, Lagos",
        dropoffLocation: "Victoria Island, Lagos",
        flightNumber: "BA74",
      },
      selectedOption,
      guestIdentity,
      selections,
    );

    expect(input.startDate.toISOString()).toBe(pickupDateTime);
    expect(input.endDate.toISOString()).toBe(dropoffDateTime);
    expect(input.flightDate).toBe("2026-03-01");
    expect(normalizedStartDate.toISOString()).toBe(pickupDateTime);
    expect(normalizedEndDate.toISOString()).toBe(dropoffDateTime);
  });
});
