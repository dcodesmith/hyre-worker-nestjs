import { describe, expect, it } from "vitest";
import { buildAirportTripDetailLines } from "./airport-trip-details";
import type { BookingDraft } from "./conversation.interface";

const airportDraft: BookingDraft = {
  bookingType: "AIRPORT_PICKUP",
  flightNumber: "BA74",
  pickupDateTime: "2026-03-01T14:40:00.000Z",
  dropoffDateTime: "2026-03-01T15:54:00.000Z",
  airportDistanceMeters: 18000,
  airportDriveIsEstimate: false,
};

describe("buildAirportTripDetailLines", () => {
  it("renders arrival, pickup, drive, distance, and drop-off for a complete airport trip", () => {
    expect(buildAirportTripDetailLines(airportDraft)).toEqual([
      "*✈️ Trip Details — BA74*",
      "*Flight Arrival:* 1st Mar 2026, 3:00 pm",
      "*Pickup Time:* 1st Mar 2026, 3:40 pm",
      "*Estimated Drive:* 1 hour 14 mins",
      "*Distance:* 18.0 km",
      "*Estimated Drop-off:* 1st Mar 2026, 4:54 pm",
    ]);
    expect(
      buildAirportTripDetailLines({ ...airportDraft, airportDriveIsEstimate: true }),
    ).toContain("*Estimated Drive:* 1 hour 14 mins (estimated)");
  });

  it("shows the next Lagos date when the drop-off crosses midnight", () => {
    expect(
      buildAirportTripDetailLines({
        ...airportDraft,
        pickupDateTime: "2026-03-01T22:20:00.000Z",
        dropoffDateTime: "2026-03-02T00:10:00.000Z",
      }),
    ).toEqual([
      "*✈️ Trip Details — BA74*",
      "*Flight Arrival:* 1st Mar 2026, 10:40 pm",
      "*Pickup Time:* 1st Mar 2026, 11:20 pm",
      "*Estimated Drive:* 1 hour 50 mins",
      "*Distance:* 18.0 km",
      "*Estimated Drop-off:* 2nd Mar 2026, 1:10 am",
    ]);
  });

  it.each<[string, Partial<BookingDraft>]>([
    ["a non-airport booking", { bookingType: "DAY" }],
    ["a missing pickup time", { pickupDateTime: undefined }],
    ["a missing drop-off time", { dropoffDateTime: undefined }],
    ["a missing distance", { airportDistanceMeters: undefined }],
    ["a non-finite distance", { airportDistanceMeters: Number.NaN }],
    ["an invalid pickup time", { pickupDateTime: "not-a-date" }],
    ["an invalid drop-off time", { dropoffDateTime: "tomorrow" }],
    ["a drop-off that is not after pickup", { dropoffDateTime: airportDraft.pickupDateTime }],
  ])("returns no lines for %s", (_label, patch) => {
    expect(buildAirportTripDetailLines({ ...airportDraft, ...patch })).toEqual([]);
  });
});
