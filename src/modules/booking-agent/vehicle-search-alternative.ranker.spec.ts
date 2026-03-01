import { describe, expect, it } from "vitest";
import { VehicleSearchAlternativeRanker } from "./vehicle-search-alternative.ranker";

describe("VehicleSearchAlternativeRanker", () => {
  const ranker = new VehicleSearchAlternativeRanker(3, 3);

  const options = [
    {
      id: "car_exact",
      make: "Toyota",
      model: "Prado",
      name: "Toyota Prado",
      color: "Black",
      vehicleType: "SUV",
      serviceTier: "STANDARD",
      imageUrl: null,
      rates: { day: 65000, night: 70000, fullDay: 110000, airportPickup: 40000 },
    },
    {
      id: "car_alt",
      make: "Toyota",
      model: "Prado",
      name: "Toyota Prado",
      color: "White",
      vehicleType: "SUV",
      serviceTier: "STANDARD",
      imageUrl: null,
      rates: { day: 66000, night: 71000, fullDay: 111000, airportPickup: 41000 },
    },
  ];

  it("selects exact matches by requested attributes", () => {
    const exact = ranker.selectExactMatches(options, {
      make: "Toyota",
      model: "Prado",
      color: "Black",
      vehicleType: "SUV",
    });

    expect(exact.map((option) => option.id)).toEqual(["car_exact"]);
  });

  it("ranks alternatives and labels reason", () => {
    const ranked = ranker.rankAlternatives(options, {
      make: "Toyota",
      model: "Prado",
      color: "Black",
      vehicleType: "SUV",
    });

    expect(ranked[0]?.id).toBe("car_alt");
    expect(ranked[0]?.reason).toBe("SAME_MODEL_DIFFERENT_COLOR");
  });
});
