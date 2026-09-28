import { describe, expect, it } from "vitest";
import { publicCarRefParamSchema } from "./dto/car-search.dto";

describe("CarController", () => {
  describe("getPublicCarByRef", () => {
    it("accepts only 16-character lowercase hexadecimal references", () => {
      expect(publicCarRefParamSchema.safeParse("0123456789abcdef").success).toBe(true);
      expect(publicCarRefParamSchema.safeParse("0123456789ABCDEf").success).toBe(false);
      expect(publicCarRefParamSchema.safeParse("short").success).toBe(false);
    });
  });
});
