import { describe, expect, it } from "vitest";
import { fleetOwnerBookingsQuerySchema } from "./fleet-owner-bookings.dto";

describe("fleetOwnerBookingsQuerySchema", () => {
  it("defaults page and limit", () => {
    expect(fleetOwnerBookingsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it("coerces numeric query strings", () => {
    expect(fleetOwnerBookingsQuerySchema.parse({ page: "2", limit: "10" })).toEqual({
      page: 2,
      limit: 10,
    });
  });

  it("rejects pages below 1 and limits above 100", () => {
    expect(fleetOwnerBookingsQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(fleetOwnerBookingsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(fleetOwnerBookingsQuerySchema.safeParse({ page: 1.5 }).success).toBe(false);
  });
});
