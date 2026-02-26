import { describe, expect, it } from "vitest";
import { VehicleSearchQueryBuilder } from "./vehicle-search-query.builder";

describe("VehicleSearchQueryBuilder", () => {
  const builder = new VehicleSearchQueryBuilder(10);

  it("parses vehicle model into make and model", () => {
    expect(builder.parseVehicleModel("Toyota Prado")).toEqual({
      make: "Toyota",
      model: "Prado",
    });
    expect(builder.parseVehicleModel("Prado")).toEqual({ model: "Prado" });
  });

  it("returns empty model mapping for empty and whitespace-only values", () => {
    expect(builder.parseVehicleModel("")).toEqual({});
    expect(builder.parseVehicleModel("   ")).toEqual({});
  });

  it("parses known multi-word makes correctly", () => {
    expect(builder.parseVehicleModel("Land Rover Defender")).toEqual({
      make: "Land Rover",
      model: "Defender",
    });
    expect(builder.parseVehicleModel("Mercedes-Benz")).toEqual({
      make: "Mercedes-Benz",
    });
    expect(builder.parseVehicleModel("Mercedes-Benz GLE 450")).toEqual({
      make: "Mercedes-Benz",
      model: "GLE 450",
    });
  });
  it("maps vehicle category directly to vehicleType", () => {
    expect(builder.mapVehicleCategory("LUXURY_SUV")).toEqual({ vehicleType: "LUXURY_SUV" });
  });

  it("builds interpretation from extracted values", () => {
    const interpretation = builder.buildInterpretationFromExtracted({
      color: "Black",
      make: "Toyota",
      model: "Prado",
      vehicleType: "SUV",
      from: "2026-03-10",
      to: "2026-03-12",
      bookingType: "DAY",
      pickupLocation: "Ikeja",
      dropoffLocation: "Victoria Island",
    });

    expect(interpretation).toContain("Looking for: Black Toyota Prado suv");
    expect(interpretation).toContain("Dates: 2026-03-10 to 2026-03-12");
    expect(interpretation).toContain("Type: DAY");
    expect(interpretation).toContain("Pickup: Ikeja");
    expect(interpretation).toContain("Drop-off: Victoria Island");
  });
  it("builds exact query with temporal and direct filters", () => {
    const query = builder.buildExactQuery({
      from: "2026-03-10",
      to: "2026-03-12",
      bookingType: "DAY",
      make: "Toyota",
      model: "Prado",
      color: "Black",
      vehicleType: "SUV",
    });

    expect(query.make).toBe("Toyota");
    expect(query.model).toBe("Prado");
    expect(query.color).toBe("Black");
    expect(query.vehicleType).toBe("SUV");
    expect(query.bookingType).toBe("DAY");
    expect(query.from).toBeInstanceOf(Date);
    expect(query.to).toBeInstanceOf(Date);
  });
  it("handles invalid date strings in exact query by skipping invalid temporal fields", () => {
    const query = builder.buildExactQuery({
      from: "invalid-date",
      to: "also-invalid",
      make: "Toyota",
    });

    expect(query.make).toBe("Toyota");
    expect(query.from).toBeUndefined();
    expect(query.to).toBeUndefined();
  });

  it("builds alternative queries and includes temporal fallback query", () => {
    const queries = builder.buildAlternativeQueries({
      from: "2026-03-10",
      to: "2026-03-12",
      color: "Black",
      make: "Toyota",
      model: "Prado",
      vehicleType: "SUV",
      serviceTier: "EXECUTIVE",
      bookingType: "DAY",
      pickupTime: "9:00 AM",
      flightNumber: "BA123",
    });

    expect(queries.length).toBeGreaterThan(1);
    expect(queries[0]).toMatchObject({
      make: "Toyota",
      model: "Prado",
    });
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page: 1,
          limit: 10,
          bookingType: "DAY",
          pickupTime: "9:00 AM",
          flightNumber: "BA123",
          from: expect.any(Date),
          to: expect.any(Date),
        }),
      ]),
    );
  });

  it("falls back to temporal-only alternative query when make/model/type are missing", () => {
    const queries = builder.buildAlternativeQueries({
      from: "2026-03-10",
      to: "2026-03-12",
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      page: 1,
      limit: 10,
      from: expect.any(Date),
      to: expect.any(Date),
    });
    expect(queries[0]?.make).toBeUndefined();
    expect(queries[0]?.model).toBeUndefined();
    expect(queries[0]?.vehicleType).toBeUndefined();
  });
});
