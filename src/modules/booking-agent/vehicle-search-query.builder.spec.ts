import { describe, expect, it } from "vitest";
import { VehicleSearchQueryBuilder } from "./vehicle-search-query.builder";

describe("VehicleSearchQueryBuilder", () => {
  const builder = new VehicleSearchQueryBuilder(10);

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

    expect(query.make).toEqual(["Toyota"]);
    expect(query.model).toBe("Prado");
    expect(query.color).toBe("Black");
    expect(query.vehicleType).toEqual(["SUV"]);
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

    expect(query.make).toEqual(["Toyota"]);
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
      make: ["Toyota"],
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
