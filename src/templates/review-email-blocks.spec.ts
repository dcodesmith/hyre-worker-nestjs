import { describe, expect, it } from "vitest";
import { formatRating, formatReviewDateDisplay } from "./review-email-blocks";

describe("review-email-blocks", () => {
  describe("formatRating", () => {
    it("formats finite values to one decimal place", () => {
      expect(formatRating(4.56)).toBe("4.6");
    });

    it("clamps values outside 0..5", () => {
      expect(formatRating(9)).toBe("5.0");
      expect(formatRating(-2)).toBe("0.0");
    });

    it("defaults non-numeric inputs to 0.0", () => {
      expect(formatRating("oops")).toBe("0.0");
    });
  });

  describe("formatReviewDateDisplay", () => {
    it("returns preformatted string inputs unchanged", () => {
      const input = "Wed, Apr 22, 2026";
      expect(formatReviewDateDisplay(input)).toBe(input);
    });

    it("returns a readable date for valid input", () => {
      const output = formatReviewDateDisplay(new Date("2026-04-22T10:00:00.000Z"));
      expect(output.length).toBeGreaterThan(0);
      expect(output).not.toBe("Invalid Date");
    });

    it("falls back to original value when date is invalid", () => {
      expect(formatReviewDateDisplay("not-a-date")).toBe("not-a-date");
    });
  });
});
