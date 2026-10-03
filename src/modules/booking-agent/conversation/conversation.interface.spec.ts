import { describe, expect, it } from "vitest";
import { convertToExtractedParams } from "./conversation.interface";

describe("conversation interface helpers", () => {
  it("keeps explicit any make and model choices out of search filters", () => {
    expect(
      convertToExtractedParams({
        vehicleType: "SUV",
        make: "ANY",
        model: "any",
      }),
    ).toEqual(
      expect.objectContaining({
        vehicleType: "SUV",
        make: undefined,
        model: undefined,
      }),
    );
  });

  it("uses exact derived airport datetimes for search and date-only fields otherwise", () => {
    expect(
      convertToExtractedParams({
        bookingType: "AIRPORT_PICKUP",
        pickupDate: "2026-03-01",
        pickupDateTime: "2026-03-01T14:40:00.000Z",
        dropoffDate: "2026-03-02",
        dropoffDateTime: "2026-03-01T15:54:00.000Z",
      }),
    ).toEqual(
      expect.objectContaining({
        from: "2026-03-01T14:40:00.000Z",
        to: "2026-03-01T15:54:00.000Z",
      }),
    );

    expect(
      convertToExtractedParams({
        bookingType: "DAY",
        pickupDate: "2026-03-01",
        pickupDateTime: "2026-03-01T14:40:00.000Z",
        dropoffDate: "2026-03-02",
        dropoffDateTime: "2026-03-01T15:54:00.000Z",
      }),
    ).toEqual(
      expect.objectContaining({
        from: "2026-03-01",
        to: "2026-03-02",
      }),
    );
  });
});
