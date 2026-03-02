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

  describe("pickupTime validation", () => {
    it("accepts 12-hour format with AM/PM", () => {
      const result = policy.resolve({
        from: "2026-03-10",
        bookingType: "DAY",
        pickupTime: "9:00 AM",
      });
      expect(result).toBeNull();
    });

    it("accepts 24-hour format", () => {
      const result = policy.resolve({
        from: "2026-03-10",
        bookingType: "DAY",
        pickupTime: "09:00",
      });
      expect(result).toBeNull();
    });

    it("accepts 24-hour format for afternoon times", () => {
      const result = policy.resolve({
        from: "2026-03-10",
        bookingType: "DAY",
        pickupTime: "14:00",
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
