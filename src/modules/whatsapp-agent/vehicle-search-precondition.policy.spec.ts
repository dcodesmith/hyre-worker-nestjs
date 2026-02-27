import { describe, expect, it } from "vitest";
import { VehicleSearchPreconditionPolicy } from "./vehicle-search-precondition.policy";

describe("VehicleSearchPreconditionPolicy", () => {
  const policy = new VehicleSearchPreconditionPolicy();

  it("returns pickup-date precondition when from is missing", () => {
    const result = policy.resolve({ make: "Toyota", model: "Prado" });
    expect(result).toEqual({
      missingField: "from",
      prompt: "What date should pickup start? Please share it as YYYY-MM-DD.",
    });
  });

  it("returns pickup-date precondition when from is an impossible calendar date", () => {
    const result = policy.resolve({
      from: "2026-02-30",
      make: "Toyota",
      model: "Prado",
    });
    expect(result).toEqual({
      missingField: "from",
      prompt: "What date should pickup start? Please share it as YYYY-MM-DD.",
    });
  });

  it("returns flight-number precondition for airport pickups", () => {
    const result = policy.resolve({
      from: "2026-03-10",
      bookingType: "AIRPORT_PICKUP",
    });
    expect(result).toEqual({
      missingField: "flightNumber",
      prompt: "Please share your flight number so I can check airport pickup availability.",
    });
  });

  it("returns flight-number precondition for airport pickups when flight number is whitespace", () => {
    const result = policy.resolve({
      from: "2026-03-10",
      bookingType: "AIRPORT_PICKUP",
      flightNumber: "   ",
    });
    expect(result).toEqual({
      missingField: "flightNumber",
      prompt: "Please share your flight number so I can check airport pickup availability.",
    });
  });

  it("clarifies booking type when booking type is missing or DAY on multi-day range", () => {
    expect(policy.shouldClarifyBookingType({ from: "2026-03-10", bookingType: "DAY" })).toBe(false);
    expect(
      policy.shouldClarifyBookingType({
        from: "2026-03-10",
        to: "2026-03-12",
        bookingType: "DAY",
      }),
    ).toBe(true);
    expect(policy.shouldClarifyBookingType({ from: "2026-03-10" })).toBe(true);
  });
});
