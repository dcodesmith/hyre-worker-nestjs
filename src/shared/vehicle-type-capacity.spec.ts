import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEATS_BY_VEHICLE_TYPE,
  inferPassengerCapacityFromVehicleClass,
  inferVehicleTypeFromClassifiers,
  resolvePassengerCapacity,
} from "./vehicle-type-capacity";

describe("inferVehicleTypeFromClassifiers", () => {
  it.each([
    ["Sport Utility Vehicle [SUV]/Multipurpose Vehicle [MPV]", "SUV"],
    ["MULTIPURPOSE PASSENGER VEHICLE (MPV)", "SUV"],
    ["Crossover Utility Vehicle (CUV)", "CROSSOVER"],
    ["Sedan/Saloon", "SEDAN"],
    ["Hatchback/Liftback/Notchback", "SEDAN"],
    ["Minivan", "VAN"],
    ["PASSENGER CAR", "SEDAN"],
    ["suv", "SUV"],
    ["Saloon", "SEDAN"],
  ] as const)("classifies %s as %s", (classifier, expected) => {
    expect(inferVehicleTypeFromClassifiers(classifier)).toBe(expected);
  });

  it("prefers the first classifiable value", () => {
    expect(inferVehicleTypeFromClassifiers("", "SUV", "Sedan")).toBe("SUV");
  });

  it.each(["Cargo Van", "Motorcycle", "Pickup", "", null, undefined])(
    "does not classify %s",
    (classifier) => {
      expect(inferVehicleTypeFromClassifiers(classifier)).toBeNull();
    },
  );
});

describe("inferPassengerCapacityFromVehicleClass", () => {
  it("uses the default seat count for the inferred type", () => {
    expect(
      inferPassengerCapacityFromVehicleClass(
        "Sport Utility Vehicle [SUV]/Multipurpose Vehicle [MPV]",
      ),
    ).toBe(DEFAULT_SEATS_BY_VEHICLE_TYPE.SUV);
    expect(inferPassengerCapacityFromVehicleClass("Minivan")).toBe(
      DEFAULT_SEATS_BY_VEHICLE_TYPE.VAN,
    );
  });
});

describe("resolvePassengerCapacity", () => {
  it("keeps a decoded seat count", () => {
    expect(resolvePassengerCapacity(7, "Sedan")).toBe(7);
  });

  it("falls back to the vehicle class when seats are missing", () => {
    expect(resolvePassengerCapacity(null, "SUV")).toBe(5);
    expect(resolvePassengerCapacity(0, "Minivan")).toBe(7);
    expect(resolvePassengerCapacity(Number.NaN, "Sedan")).toBe(5);
  });

  it("returns null when neither seats nor vehicle class can be used", () => {
    expect(resolvePassengerCapacity(null, "Pickup")).toBeNull();
    expect(resolvePassengerCapacity(16, "")).toBeNull();
  });
});
