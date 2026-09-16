import { describe, expect, it } from "vitest";
import { registrationNumberSchema } from "./create-car.dto";

describe("registrationNumberSchema", () => {
  it("accepts the Prembly sandbox plate format used by the web onboarding form", () => {
    expect(registrationNumberSchema.parse("aaa000000")).toBe("AAA000000");
  });

  it("rejects an unsupported plate format", () => {
    expect(registrationNumberSchema.safeParse("INVALID").success).toBe(false);
  });
});
