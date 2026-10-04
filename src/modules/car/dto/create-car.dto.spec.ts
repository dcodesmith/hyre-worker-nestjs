import { afterEach, describe, expect, it, vi } from "vitest";
import { minimumVehicleYear } from "../car.const";
import { carBaseBodySchema, registrationNumberSchema } from "./create-car.dto";

describe("registrationNumberSchema", () => {
  it("accepts the Prembly sandbox plate format used by the web onboarding form", () => {
    expect(registrationNumberSchema.parse("aaa000000")).toBe("AAA000000");
  });

  it("rejects an unsupported plate format", () => {
    expect(registrationNumberSchema.safeParse("INVALID").success).toBe(false);
  });
});

describe("minimumVehicleYear", () => {
  it("is 15 years before the Lagos calendar year", () => {
    expect(minimumVehicleYear(new Date("2026-09-19T12:00:00.000Z"))).toBe(2011);
    expect(minimumVehicleYear(new Date("2026-12-31T22:30:00.000Z"))).toBe(2011);
    expect(minimumVehicleYear(new Date("2026-12-31T23:30:00.000Z"))).toBe(2012);
  });
});

describe("year", () => {
  const year = carBaseBodySchema.shape.year;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the 15-year floor and next model year", () => {
    expect(year.parse(minimumVehicleYear())).toBe(minimumVehicleYear());
    expect(year.parse(new Date().getFullYear() + 1)).toBe(new Date().getFullYear() + 1);
  });

  it("rejects a vehicle older than 15 years in production", () => {
    vi.stubEnv("APP_ENV", "production");
    expect(year.safeParse(minimumVehicleYear() - 1).success).toBe(false);
  });

  it.each(["development", "preview"])("accepts an older vehicle in %s", (appEnv) => {
    vi.stubEnv("APP_ENV", appEnv);
    expect(year.safeParse(minimumVehicleYear() - 1).success).toBe(true);
  });

  it.each(["development", "preview", "production"])(
    "rejects a model year beyond next year in %s",
    (appEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      expect(year.safeParse(new Date().getFullYear() + 2).success).toBe(false);
    },
  );
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
