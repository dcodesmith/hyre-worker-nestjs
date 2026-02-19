import { describe, expect, it } from "vitest";
import { ISO_DATE_ONLY_REGEX, parseIsoDateOnlyToUtc } from "./flightaware.const";

describe("flightaware.const", () => {
  describe("ISO_DATE_ONLY_REGEX", () => {
    it("should match valid ISO date-only values", () => {
      expect(ISO_DATE_ONLY_REGEX.test("2025-12-25")).toBe(true);
    });

    it("should not match non date-only values", () => {
      expect(ISO_DATE_ONLY_REGEX.test("2025-12-25T00:00:00Z")).toBe(false);
      expect(ISO_DATE_ONLY_REGEX.test("12/25/2025")).toBe(false);
    });
  });

  describe("parseIsoDateOnlyToUtc", () => {
    it("should parse a valid ISO date-only string as UTC midnight", () => {
      const parsed = parseIsoDateOnlyToUtc("2025-12-25");

      expect(parsed).not.toBeNull();
      expect(parsed?.toISOString()).toBe("2025-12-25T00:00:00.000Z");
    });

    it("should return null for invalid calendar dates", () => {
      expect(parseIsoDateOnlyToUtc("2025-02-31")).toBeNull();
    });

    it("should return null for non date-only values", () => {
      expect(parseIsoDateOnlyToUtc("2025-12-25T00:00:00Z")).toBeNull();
      expect(parseIsoDateOnlyToUtc("2025/12/25")).toBeNull();
    });
  });
});
