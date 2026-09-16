import { describe, expect, it } from "vitest";
import { redactVinInUrl, VIN_PATTERN } from "./vehicle-validation";

const VIN = "1HGCM82633A004352";

describe("redactVinInUrl", () => {
  it("redacts a VIN path segment and leaves the query string", () => {
    expect(redactVinInUrl(`/vehicles/DecodeVinValues/${VIN}?format=json`)).toBe(
      "/vehicles/DecodeVinValues/[REDACTED]?format=json",
    );
  });

  it("leaves URLs without a VIN unchanged", () => {
    expect(redactVinInUrl("/verification/vehicle/vin")).toBe("/verification/vehicle/vin");
  });

  it("redacts a bare VIN URL", () => {
    expect(redactVinInUrl(VIN)).toBe("[REDACTED]");
  });

  it("returns undefined when no URL was logged", () => {
    expect(redactVinInUrl(undefined)).toBeUndefined();
  });

  it("does not treat a 17-character I/O/Q string as a VIN", () => {
    expect(VIN_PATTERN.test("1HGCM82633A00435I")).toBe(false);
    expect(redactVinInUrl("/vehicles/DecodeVinValues/1HGCM82633A00435I")).toBe(
      "/vehicles/DecodeVinValues/1HGCM82633A00435I",
    );
  });
});
