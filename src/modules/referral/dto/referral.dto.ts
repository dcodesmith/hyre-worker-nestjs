import { z } from "zod";

const referralCodePattern = /^[A-Z0-9]{8}$/;

export const referralCodeParamSchema = z
  .string()
  .trim()
  .length(8, "Referral code must be exactly 8 characters")
  .transform((value) => value.toUpperCase())
  .refine((value) => referralCodePattern.test(value), {
    message: "Referral code must contain only letters and numbers",
  });

export type ReferralCodeParamDto = z.infer<typeof referralCodeParamSchema>;

export const validateReferralQuerySchema = z.object({
  email: z.string().trim().optional().default(""),
});

export type ValidateReferralQueryDto = z.infer<typeof validateReferralQuerySchema>;

export const referralEligibilityQuerySchema = z.object({
  amount: z.coerce.number().int().min(1, "Amount must be greater than 0"),
  type: z.enum(["DAY", "NIGHT", "FULL_DAY"], {
    error: "Booking type is required and must be valid.",
  }),
});

export type ReferralEligibilityQueryDto = z.infer<typeof referralEligibilityQuerySchema>;
