import { describe, expect, it } from "vitest";
import type { VehicleSearchOption } from "../booking-agent.interface";
import { buildBookingInputFromDraft, buildGuestIdentity } from "./langgraph-booking-orchestrator";

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

describe("buildBookingInputFromDraft", () => {
  it("passes explicit pickupTime through to both normalized window and input payload", () => {
    const { input, normalizedStartDate, normalizedEndDate } = buildBookingInputFromDraft(
      {
        pickupDate: "2026-03-03",
        dropoffDate: "2026-03-03",
        bookingType: "DAY",
        pickupTime: "10:00",
        pickupLocation: "Wheat Baker Hotel, Ikoyi",
        dropoffLocation: "Wheat Baker Hotel, Ikoyi",
      },
      selectedOption,
      guestIdentity,
    );

    expect(input.bookingType).toBe("DAY");
    expect(input.pickupTime).toBe("10 AM");
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
    );

    expect(input.pickupTime).toBe("7:00 AM");

    expect(normalizedStartDate.getHours()).toBe(7);
    expect(normalizedEndDate.getHours()).toBe(19);
    expect(normalizedEndDate.getTime() - normalizedStartDate.getTime()).toBe(TWELVE_HOURS);
  });
});
