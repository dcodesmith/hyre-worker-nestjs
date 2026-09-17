import { BookingType, ReferralIncentiveType, ReferralProgramStatus } from "@prisma/client";
import { z } from "zod";

const moneySchema = z.coerce.number().positive().max(99_999_999.99).multipleOf(0.01);

export const referralIncentiveSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(ReferralIncentiveType.FIXED),
    amount: moneySchema,
  }),
  z.object({
    type: z.literal(ReferralIncentiveType.PERCENTAGE),
    percentage: z.coerce.number().positive().max(100).multipleOf(0.01),
    maxAmount: moneySchema,
  }),
]);

const referralProgramValuesSchema = z.object({
  refereeDiscount: referralIncentiveSchema,
  referrerReward: referralIncentiveSchema,
  minimumBookingAmount: moneySchema,
  eligibleBookingTypes: z.array(z.enum(BookingType)).min(1),
  referralValidityDays: z.coerce.number().int().min(0).max(3650),
  maxCreditsPerBookingAmount: z.coerce.number().min(0).max(99_999_999.99).multipleOf(0.01),
  maxCreditsPerBookingPercent: z.coerce.number().min(0).max(100).multipleOf(0.01),
});

export const createReferralProgramSchema = referralProgramValuesSchema;
export type CreateReferralProgramDto = z.infer<typeof createReferralProgramSchema>;

export const updateReferralProgramSchema = referralProgramValuesSchema
  .partial()
  .extend({ status: z.enum(ReferralProgramStatus).optional() })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one referral programme field must be provided",
  });
export type UpdateReferralProgramDto = z.infer<typeof updateReferralProgramSchema>;

export const referralProgramHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ReferralProgramHistoryQueryDto = z.infer<typeof referralProgramHistoryQuerySchema>;
