import { describe, expect, it } from "vitest";
import {
  DRIVERS_LICENSE_NUMBER_INVALID,
  driversLicenseNumberSchema,
  normalizeDriversLicenseNumber,
  optionalDriversLicenseNumberSchema,
} from "./drivers-license-number";

describe("normalizeDriversLicenseNumber", () => {
  it("uppercases and strips spaces and hyphens", () => {
    expect(normalizeDriversLicenseNumber("  abc-12345-de67  ")).toBe("ABC12345DE67");
    expect(normalizeDriversLicenseNumber("fn 63483 at78")).toBe("FN63483AT78");
  });
});

describe("driversLicenseNumberSchema", () => {
  it.each(["ABC12345DE67", "FN63483AT78", "  abc-12345-de67  ", "ABC 12345 DE67"] as const)(
    "accepts %s",
    (driversLicenseNumber) => {
      const parsed = driversLicenseNumberSchema.safeParse(driversLicenseNumber);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toMatch(/^[A-Z]{2,3}\d{5}[A-Z]{2}\d{2}$/);
      }
    },
  );

  it("canonicalizes a hyphenated 3-letter number", () => {
    expect(driversLicenseNumberSchema.parse("  abc-12345-de67  ")).toBe("ABC12345DE67");
  });

  it.each([
    ["legacy short number", "ABC12345"],
    ["Prembly sandbox digits", "AAD23208212298"],
    ["one leading letter", "F63483AT78"],
    ["four serial digits", "FN6348AT78"],
    ["one middle letter", "FN63483A78"],
    ["spaces that do not form a card number", "ABC 12345"],
    ["underscore", "ABC_12345DE67"],
  ] as const)("rejects a %s", (_label, driversLicenseNumber) => {
    const parsed = driversLicenseNumberSchema.safeParse(driversLicenseNumber);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(DRIVERS_LICENSE_NUMBER_INVALID);
    }
  });
});

describe("optionalDriversLicenseNumberSchema", () => {
  it("treats blank values as absent", () => {
    expect(optionalDriversLicenseNumberSchema.parse("")).toBeUndefined();
    expect(optionalDriversLicenseNumberSchema.parse("   ")).toBeUndefined();
    expect(optionalDriversLicenseNumberSchema.parse(" - ")).toBeUndefined();
  });

  it("still canonicalizes a present number", () => {
    expect(optionalDriversLicenseNumberSchema.parse("fn-63483-at78")).toBe("FN63483AT78");
  });
});
