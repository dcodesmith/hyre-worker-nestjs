import { describe, expect, it } from "vitest";
import { getMissingRequiredFields } from "./booking-agent.helper";
import { REQUIRED_SEARCH_FIELDS } from "./conversation/conversation.const";

describe("getMissingRequiredFields", () => {
  it("requires flight date, type, flight number, vehicle, and dropoff for airport pickup", () => {
    expect(REQUIRED_SEARCH_FIELDS.AIRPORT_PICKUP).toEqual([
      "pickupDate",
      "bookingType",
      "flightNumber",
      "vehicleType",
      "dropoffLocation",
    ]);
    expect(getMissingRequiredFields({ bookingType: "AIRPORT_PICKUP" })).toEqual([
      "pickupDate",
      "flightNumber",
      "vehicleType",
      "dropoffLocation",
    ]);
    expect(
      getMissingRequiredFields({
        bookingType: "AIRPORT_PICKUP",
        pickupDate: "2026-03-01",
        flightNumber: "BA74",
        vehicleType: "SUV",
        dropoffLocation: "Victoria Island",
      }),
    ).toEqual([]);
  });

  it("keeps the original required fields for other booking types", () => {
    expect(REQUIRED_SEARCH_FIELDS.DEFAULT).toEqual([
      "pickupDate",
      "bookingType",
      "vehicleType",
      "pickupLocation",
      "pickupTime",
      "dropoffDate",
      "dropoffLocation",
    ]);
    expect(getMissingRequiredFields({ bookingType: "DAY" })).toEqual([
      "pickupDate",
      "vehicleType",
      "pickupLocation",
      "pickupTime",
      "dropoffDate",
      "dropoffLocation",
    ]);
    expect(getMissingRequiredFields({ bookingType: "NIGHT" })).toEqual(
      getMissingRequiredFields({ bookingType: "DAY" }),
    );
    expect(getMissingRequiredFields({ bookingType: "FULL_DAY" })).toEqual(
      getMissingRequiredFields({ bookingType: "DAY" }),
    );
  });
});
