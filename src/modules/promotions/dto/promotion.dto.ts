import { z } from "zod";
import { MAX_PROMOTION_PERCENTAGE } from "../promotion.constants";

export const promotionIdParamSchema = z.cuid("Invalid promotion ID");

export const createPromotionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .max(120, "Promotion name must be 120 characters or less")
      .optional()
      .or(z.literal("")),
    carId: z.string().trim().min(1, "carId cannot be empty").optional().nullable(),
    discountValue: z
      .number({ error: "Discount percentage is required" })
      .min(1, "Discount must be at least 1%")
      .max(MAX_PROMOTION_PERCENTAGE, `Discount cannot exceed ${MAX_PROMOTION_PERCENTAGE}%`),
    startDate: z.iso.date({ error: "Start date must be in YYYY-MM-DD format" }),
    endDate: z.iso.date({ error: "End date must be in YYYY-MM-DD format" }),
  })
  .refine((data) => new Date(data.endDate) >= new Date(data.startDate), {
    message: "End date must be on or after start date",
    path: ["endDate"],
  });

export type CreatePromotionDto = z.infer<typeof createPromotionSchema>;
