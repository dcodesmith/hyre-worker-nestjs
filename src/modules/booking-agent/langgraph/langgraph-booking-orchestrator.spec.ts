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

describe("buildBookingInputFromDraft", () => {
  it("normalizes DAY same-day bookings to a 12-hour window", () => {
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
    expect(normalizedEndDate.getTime() - normalizedStartDate.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  it("normalizes multi-day DAY bookings using dropoff day end window", () => {
    const { normalizedStartDate, normalizedEndDate } = buildBookingInputFromDraft(
      {
        pickupDate: "2026-03-03",
        dropoffDate: "2026-03-05",
        bookingType: "DAY",
        pickupTime: "10 AM",
        pickupLocation: "Wheat Baker Hotel, Ikoyi",
        dropoffLocation: "Wheat Baker Hotel, Ikoyi",
      },
      selectedOption,
      guestIdentity,
    );

    expect(normalizedStartDate.toISOString()).toBe("2026-03-03T10:00:00.000Z");
    expect(normalizedEndDate.toISOString()).toBe("2026-03-05T22:00:00.000Z");
  });

  it("normalizes FULL_DAY bookings to 24-hour spans", () => {
    const { input, normalizedStartDate, normalizedEndDate } = buildBookingInputFromDraft(
      {
        pickupDate: "2026-03-03",
        dropoffDate: "2026-03-04",
        bookingType: "FULL_DAY",
        pickupTime: "10 AM",
        pickupLocation: "Wheat Baker Hotel, Ikoyi",
        dropoffLocation: "Wheat Baker Hotel, Ikoyi",
      },
      selectedOption,
      guestIdentity,
    );

    expect(input.bookingType).toBe("FULL_DAY");
    expect(normalizedEndDate.getTime() - normalizedStartDate.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("normalizes NIGHT bookings to 11 PM - 5 AM window", () => {
    const { input, normalizedStartDate, normalizedEndDate } = buildBookingInputFromDraft(
      {
        pickupDate: "2026-03-03",
        dropoffDate: "2026-03-04",
        bookingType: "NIGHT",
        pickupTime: "11 PM",
        pickupLocation: "Wheat Baker Hotel, Ikoyi",
        dropoffLocation: "Wheat Baker Hotel, Ikoyi",
      },
      selectedOption,
      guestIdentity,
    );

    expect(input.bookingType).toBe("NIGHT");
    expect(normalizedStartDate.getHours()).toBe(23);
    expect(normalizedEndDate.getHours()).toBe(5);
    expect(normalizedEndDate.getTime() - normalizedStartDate.getTime()).toBe(6 * 60 * 60 * 1000);
  });
});
