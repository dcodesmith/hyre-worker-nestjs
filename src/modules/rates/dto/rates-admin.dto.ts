import { AddonType, PlatformFeeType } from "@prisma/client";
import { z } from "zod";

type DateRangeInput = {
  effectiveSince: Date;
  effectiveUntil?: Date;
};

const withValidDateRange = <T extends DateRangeInput>(schema: z.ZodType<T>) =>
  schema.superRefine((value, ctx) => {
    if (value.effectiveUntil && value.effectiveSince >= value.effectiveUntil) {
      ctx.addIssue({
        code: "custom",
        message: "effectiveSince must be before effectiveUntil",
        path: ["effectiveUntil"],
      });
    }
  });

export const createPlatformFeeSchema = withValidDateRange(
  z.object({
    feeType: z.enum(PlatformFeeType),
    ratePercent: z.coerce.number().min(0).max(100),
    effectiveSince: z.coerce.date(),
    effectiveUntil: z.coerce.date().optional(),
    description: z.string().trim().max(500).optional(),
  }),
);

export type CreatePlatformFeeDto = z.infer<typeof createPlatformFeeSchema>;

export const createVatRateSchema = withValidDateRange(
  z.object({
    ratePercent: z.coerce.number().min(0).max(100),
    effectiveSince: z.coerce.date(),
    effectiveUntil: z.coerce.date().optional(),
    description: z.string().trim().max(500).optional(),
  }),
);

export type CreateVatRateDto = z.infer<typeof createVatRateSchema>;

export const createAddonRateSchema = withValidDateRange(
  z.object({
    addonType: z.enum(AddonType),
    rateAmount: z.coerce.number().min(0),
    effectiveSince: z.coerce.date(),
    effectiveUntil: z.coerce.date().optional(),
    description: z.string().trim().max(500).optional(),
  }),
);

export type CreateAddonRateDto = z.infer<typeof createAddonRateSchema>;

export const addonRateIdParamSchema = z.cuid();
