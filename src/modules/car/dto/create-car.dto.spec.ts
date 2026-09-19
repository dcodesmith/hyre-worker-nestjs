import { describe, expect, it } from "vitest";
import { carBaseBodySchema, registrationNumberSchema } from "./create-car.dto";

describe("registrationNumberSchema", () => {
  it("accepts the Prembly sandbox plate format used by the web onboarding form", () => {
    expect(registrationNumberSchema.parse("aaa000000")).toBe("AAA000000");
  });

  it("rejects an unsupported plate format", () => {
    expect(registrationNumberSchema.safeParse("INVALID").success).toBe(false);
  });
});

describe("passengerCapacity", () => {
  const passengerCapacity = carBaseBodySchema.shape.passengerCapacity;

  it("accepts 4 through 60", () => {
    expect(passengerCapacity.parse(4)).toBe(4);
    expect(passengerCapacity.parse(60)).toBe(60);
  });

  it("rejects values below 4 or above 60", () => {
    expect(passengerCapacity.safeParse(3).success).toBe(false);
    expect(passengerCapacity.safeParse(61).success).toBe(false);
  });
});
