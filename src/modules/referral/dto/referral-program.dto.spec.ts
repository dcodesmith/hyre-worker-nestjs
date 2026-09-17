import { BookingType, ReferralIncentiveType, ReferralProgramStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  createReferralProgramSchema,
  referralProgramHistoryQuerySchema,
  updateReferralProgramSchema,
} from "./referral-program.dto";

const validProgram = {
  refereeDiscount: { type: ReferralIncentiveType.FIXED, amount: 10000 },
  referrerReward: { type: ReferralIncentiveType.PERCENTAGE, percentage: 10, maxAmount: 5000 },
  minimumBookingAmount: 20000,
  eligibleBookingTypes: [BookingType.DAY],
  referralValidityDays: 30,
  maxCreditsPerBookingAmount: 30000,
  maxCreditsPerBookingPercent: 50,
};

describe("referral program DTO schemas", () => {
  describe("createReferralProgramSchema", () => {
    it("accepts a valid FIXED + PERCENTAGE programme", () => {
      const parsed = createReferralProgramSchema.safeParse(validProgram);
      expect(parsed.success).toBe(true);
    });

    it("rejects a missing incentive field", () => {
      const { refereeDiscount: _, ...rest } = validProgram;
      expect(createReferralProgramSchema.safeParse(rest).success).toBe(false);
    });

    it("rejects a PERCENTAGE incentive without maxAmount", () => {
      expect(
        createReferralProgramSchema.safeParse({
          ...validProgram,
          referrerReward: { type: ReferralIncentiveType.PERCENTAGE, percentage: 10 },
        }).success,
      ).toBe(false);
    });

    it("rejects a percentage above 100", () => {
      expect(
        createReferralProgramSchema.safeParse({
          ...validProgram,
          referrerReward: {
            type: ReferralIncentiveType.PERCENTAGE,
            percentage: 100.01,
            maxAmount: 5000,
          },
        }).success,
      ).toBe(false);
    });

    it("rejects an empty eligible booking type list", () => {
      expect(
        createReferralProgramSchema.safeParse({
          ...validProgram,
          eligibleBookingTypes: [],
        }).success,
      ).toBe(false);
    });
  });

  describe("updateReferralProgramSchema", () => {
    it("requires at least one field", () => {
      const parsed = updateReferralProgramSchema.safeParse({});
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe(
          "At least one referral programme field must be provided",
        );
      }
    });

    it("accepts a status-only pause", () => {
      expect(
        updateReferralProgramSchema.safeParse({ status: ReferralProgramStatus.PAUSED }).success,
      ).toBe(true);
    });

    it("accepts a partial value edit", () => {
      expect(updateReferralProgramSchema.safeParse({ minimumBookingAmount: 25000 }).success).toBe(
        true,
      );
    });
  });

  describe("referralProgramHistoryQuerySchema", () => {
    it("defaults page and pageSize", () => {
      const parsed = referralProgramHistoryQuerySchema.safeParse({});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({ page: 1, pageSize: 20 });
      }
    });

    it("rejects a pageSize above 100", () => {
      expect(referralProgramHistoryQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    });
  });
});
