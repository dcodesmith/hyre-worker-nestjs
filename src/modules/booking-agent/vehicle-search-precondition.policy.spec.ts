import { describe, expect, it } from "vitest";
import {
  parseSearchDate,
  VehicleSearchPreconditionPolicy,
} from "./vehicle-search-precondition.policy";

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

  it("parses timezone-qualified ISO datetimes", () => {
    expect(parseSearchDate("2026-03-01T14:40:00.000Z")?.toISOString()).toBe(
      "2026-03-01T14:40:00.000Z",
    );
    expect(parseSearchDate("2026-03-01T14:40:00+01:00")?.toISOString()).toBe(
      "2026-03-01T13:40:00.000Z",
    );
  });

  it.each([
    "2026-02-30T10:00:00Z",
    "2026-02-30T10:00:00+01:00",
    "2026-03-01T14:40:00",
    "2026-03-01T14:40Z",
    "2026-03-01Tnot-a-time",
  ])("rejects invalid or timezone-less ISO datetime %s", (value) => {
    expect(parseSearchDate(value)).toBeNull();
  });

  it("accepts an ISO pickup and dropoff window", () => {
    const result = policy.resolve({
      from: "2026-03-01T14:40:00.000Z",
      to: "2026-03-01T15:54:00.000Z",
      bookingType: "DAY",
      pickupTime: "15:40",
    });
    expect(result).toBeNull();
  });

  describe("pickupTime validation", () => {
    it.each(["9:00 AM", "09:00", "14:00"])("accepts pickup time %s", (pickupTime) => {
      const result = policy.resolve({
        from: "2026-03-10",
        bookingType: "DAY",
        pickupTime,
      });
      expect(result).toBeNull();
    });

    it("rejects invalid time format", () => {
      const result = policy.resolve({
        from: "2026-03-10",
        bookingType: "DAY",
        pickupTime: "nine o'clock",
      });
      expect(result).toEqual({
        missingField: "pickupTime",
        prompt: "Please share pickup time in this format: 9:00 AM or 14:00.",
      });
    });
  });
});
