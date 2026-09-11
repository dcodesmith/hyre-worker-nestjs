import { describe, expect, it } from "vitest";
import {
  createAddonPriceSchema,
  createAddonSchema,
  listPublicAddonsQuerySchema,
  updateAddonSchema,
} from "./addons.dto";

describe("addons DTO schemas", () => {
  describe("listPublicAddonsQuerySchema", () => {
    it("requires a booking type", () => {
      expect(listPublicAddonsQuerySchema.safeParse({}).success).toBe(false);
      expect(listPublicAddonsQuerySchema.safeParse({ bookingType: "DAY" }).success).toBe(true);
    });
  });

  describe("createAddonSchema", () => {
    const valid = {
      code: "WIFI_HOTSPOT",
      name: "Wi-Fi Hotspot",
      bookingTypes: ["DAY"],
      pricingUnit: "PER_BOOKING",
      financialTreatment: "PLATFORM",
    };

    it("accepts UPPER_SNAKE_CASE codes and defaults isActive", () => {
      const parsed = createAddonSchema.safeParse(valid);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.isActive).toBe(true);
      }
    });

    it("rejects lowercase codes", () => {
      expect(createAddonSchema.safeParse({ ...valid, code: "wifi_hotspot" }).success).toBe(false);
    });

    it("rejects duplicate booking types", () => {
      expect(createAddonSchema.safeParse({ ...valid, bookingTypes: ["DAY", "DAY"] }).success).toBe(
        false,
      );
    });

    it("rejects unknown fields", () => {
      expect(createAddonSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    });
  });

  describe("updateAddonSchema", () => {
    it("requires at least one field", () => {
      const parsed = updateAddonSchema.safeParse({});
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe("At least one field is required");
      }
    });

    it("accepts a partial update", () => {
      expect(updateAddonSchema.safeParse({ isActive: false }).success).toBe(true);
    });
  });

  describe("createAddonPriceSchema", () => {
    it("accepts an open-ended price window", () => {
      expect(
        createAddonPriceSchema.safeParse({
          amount: 15000,
          effectiveSince: "2026-01-01",
        }).success,
      ).toBe(true);
    });

    it("rejects effectiveSince that is not before effectiveUntil", () => {
      const parsed = createAddonPriceSchema.safeParse({
        amount: 15000,
        effectiveSince: "2026-06-01",
        effectiveUntil: "2026-03-01",
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe(
          "effectiveSince must be before effectiveUntil",
        );
      }
    });
  });
});
