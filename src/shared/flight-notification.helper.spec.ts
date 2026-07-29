import { describe, expect, it } from "vitest";
import {
  buildFlightArrivalLocation,
  calculatePickupActivationTime,
  formatFlightOperationalTime,
} from "./flight-notification.helper";

describe("flight notification helpers", () => {
  it("calculates pickup activation forty minutes after arrival", () => {
    expect(calculatePickupActivationTime(new Date("2030-01-01T10:00:00.000Z"))).toEqual(
      new Date("2030-01-01T10:40:00.000Z"),
    );
    expect(calculatePickupActivationTime(null)).toBeNull();
  });

  it("formats operational times in Lagos time", () => {
    expect(formatFlightOperationalTime(new Date("2030-01-01T10:00:00.000Z"))).toBe(
      "1 Jan 2030, 11:00 AM GMT+1",
    );
    expect(formatFlightOperationalTime(null)).toBe("Not currently available");
  });

  it("builds an arrival location from available parts", () => {
    expect(buildFlightArrivalLocation("LOS", "2", "G4")).toBe("LOS, Terminal 2, Gate G4");
    expect(buildFlightArrivalLocation("LOS")).toBe("LOS");
  });
});
