import { describe, expect, it } from "vitest";
import { parseReferralProgramConfig } from "./referral-program-config";

describe("parseReferralProgramConfig", () => {
  it("applies documented defaults when no rows are stored", () => {
    expect(parseReferralProgramConfig([])).toEqual({
      enabled: true,
      discountAmount: 10000,
      minBookingAmount: 20000,
      eligibleTypes: ["DAY", "NIGHT", "FULL_DAY"],
      releaseCondition: "COMPLETED",
      expiryDays: 30,
      maxCreditsPerBooking: 30000,
      rewardAmount: 0,
    });
  });

  it("reads stored values without re-coercing at the caller", () => {
    expect(
      parseReferralProgramConfig([
        { key: "REFERRAL_ENABLED", value: false },
        { key: "REFERRAL_DISCOUNT_AMOUNT", value: "5000" },
        { key: "REFERRAL_MIN_BOOKING_AMOUNT", value: 25000 },
        { key: "REFERRAL_ELIGIBLE_TYPES", value: ["DAY"] },
        { key: "REFERRAL_RELEASE_CONDITION", value: "PAID" },
        { key: "REFERRAL_EXPIRY_DAYS", value: 0 },
        { key: "REFERRAL_MAX_CREDITS_PER_BOOKING", value: "15000" },
        { key: "REFERRAL_REWARD_AMOUNT", value: "2500" },
      ]),
    ).toEqual({
      enabled: false,
      discountAmount: 5000,
      minBookingAmount: 25000,
      eligibleTypes: ["DAY"],
      releaseCondition: "PAID",
      expiryDays: 0,
      maxCreditsPerBooking: 15000,
      rewardAmount: 2500,
    });
  });

  it("treats string false as disabled", () => {
    expect(parseReferralProgramConfig([{ key: "REFERRAL_ENABLED", value: "false" }]).enabled).toBe(
      false,
    );
  });

  it("uses discount amount for reward only when that key is present", () => {
    expect(
      parseReferralProgramConfig([{ key: "REFERRAL_DISCOUNT_AMOUNT", value: 10000 }]).rewardAmount,
    ).toBe(10000);
    expect(parseReferralProgramConfig([]).rewardAmount).toBe(0);
  });

  it("treats non-finite money values as zero instead of Infinity", () => {
    expect(
      parseReferralProgramConfig([{ key: "REFERRAL_DISCOUNT_AMOUNT", value: "1e999" }])
        .discountAmount,
    ).toBe(0);
  });

  it("coerces unknown release conditions to COMPLETED", () => {
    expect(
      parseReferralProgramConfig([{ key: "REFERRAL_RELEASE_CONDITION", value: "IMMEDIATE" }])
        .releaseCondition,
    ).toBe("COMPLETED");
  });
});
