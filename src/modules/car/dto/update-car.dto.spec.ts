import { describe, expect, it } from "vitest";
import { updateCarBodySchema } from "./update-car.dto";

describe("updateCarBodySchema", () => {
  it("does not inject a default color into unrelated updates", () => {
    expect(updateCarBodySchema.parse({ dayRate: 55_000 })).toEqual({ dayRate: 55_000 });
  });

  it("trims an explicitly updated color", () => {
    expect(updateCarBodySchema.parse({ color: "  Blue  " })).toEqual({ color: "Blue" });
  });
});
