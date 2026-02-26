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

  it("maps vehicle category directly to vehicleType", () => {
    expect(builder.mapVehicleCategory("LUXURY_SUV")).toEqual({ vehicleType: "LUXURY_SUV" });
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
});
