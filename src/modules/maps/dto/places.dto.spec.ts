import { describe, expect, it } from "vitest";
import { placesAutocompleteQuerySchema } from "./places-autocomplete.dto";
import { resolvePlaceBodySchema } from "./resolve-place.dto";
import { validatePlaceBodySchema } from "./validate-place.dto";

describe("Places DTO schemas", () => {
  describe("placesAutocompleteQuerySchema", () => {
    it("accepts valid query and applies default limit", () => {
      const parsed = placesAutocompleteQuerySchema.parse({
        input: "Eko Hotel",
        sessionToken: "session-token-1",
      });

      expect(parsed).toEqual({
        input: "Eko Hotel",
        sessionToken: "session-token-1",
        limit: 4,
      });
    });

    it("rejects inputs below minimum length", () => {
      const result = placesAutocompleteQuerySchema.safeParse({ input: "a" });
      expect(result.success).toBe(false);
    });

    it("rejects limits above max cap", () => {
      const result = placesAutocompleteQuerySchema.safeParse({
        input: "Lekki",
        limit: 9,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("resolvePlaceBodySchema", () => {
    it("accepts valid placeId body", () => {
      const parsed = resolvePlaceBodySchema.parse({
        placeId: "ChIJ12345",
      });

      expect(parsed).toEqual({
        placeId: "ChIJ12345",
      });
    });

    it("rejects missing placeId", () => {
      const result = resolvePlaceBodySchema.safeParse({
        placeId: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validatePlaceBodySchema", () => {
    it("accepts strict validation input", () => {
      const parsed = validatePlaceBodySchema.parse({
        input: "12 Glover Road, Ikoyi",
      });

      expect(parsed).toEqual({
        input: "12 Glover Road, Ikoyi",
      });
    });

    it("rejects blank or too-short input", () => {
      const result = validatePlaceBodySchema.safeParse({
        input: " ",
      });
      expect(result.success).toBe(false);
    });
  });
});
