import { AddonFinancialTreatment, AddonPricingUnit, BookingType } from "@prisma/client";
import { z } from "zod";

const bookingTypesSchema = z
  .array(z.enum(BookingType))
  .min(1, "At least one booking type is required")
  .refine((values) => new Set(values).size === values.length, {
    message: "Booking types must be unique",
  });

export const listPublicAddonsQuerySchema = z.object({
  bookingType: z.enum(BookingType),
});

export const addonIdParamSchema = z.cuid();
export const addonPriceIdParamSchema = z.cuid();

export const createAddonSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/, "Code must use UPPER_SNAKE_CASE"),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    bookingTypes: bookingTypesSchema,
    pricingUnit: z.enum(AddonPricingUnit),
    financialTreatment: z.enum(AddonFinancialTreatment),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateAddonSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    bookingTypes: bookingTypesSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export const createAddonPriceSchema = z
  .object({
    amount: z.coerce.number().positive().max(99_999_999.99).multipleOf(0.01),
    effectiveSince: z.coerce.date(),
    effectiveUntil: z.coerce.date().optional(),
  })
  .strict()
  .refine(
    ({ effectiveSince, effectiveUntil }) => !effectiveUntil || effectiveSince < effectiveUntil,
    {
      message: "effectiveSince must be before effectiveUntil",
      path: ["effectiveUntil"],
    },
  );

export type ListPublicAddonsQueryDto = z.infer<typeof listPublicAddonsQuerySchema>;
export type CreateAddonDto = z.infer<typeof createAddonSchema>;
export type UpdateAddonDto = z.infer<typeof updateAddonSchema>;
export type CreateAddonPriceDto = z.infer<typeof createAddonPriceSchema>;
