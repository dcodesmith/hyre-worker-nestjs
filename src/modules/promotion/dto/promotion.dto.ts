import { z } from "zod";

export const MAX_PROMOTION_PERCENTAGE = 50;
export const MIN_PROMOTION_PERCENTAGE = 1;
export const PROMOTION_SCOPES = ["FLEET", "CAR"] as const;

const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const calendarDateSchema = z
  .string()
  .regex(CALENDAR_DATE_REGEX, "Date must be in YYYY-MM-DD format");

/**
 * Payload for creating a promotion.
 *
 * `startDate` is inclusive; `endDate` is the last day the promotion applies
 * (server converts to exclusive at persistence time in the Lagos timezone).
 * `scope` explicitly declares whether the promotion targets the whole fleet
 * or one car.
 */
export const createPromotionBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    scope: z.enum(PROMOTION_SCOPES),
    carId: z.cuid().optional(),
    discountValue: z
      .number()
      .min(MIN_PROMOTION_PERCENTAGE, `Discount must be at least ${MIN_PROMOTION_PERCENTAGE}%`)
      .max(MAX_PROMOTION_PERCENTAGE, `Discount cannot exceed ${MAX_PROMOTION_PERCENTAGE}%`),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
  })
  .superRefine((data, ctx) => {
    if (data.scope === "CAR" && !data.carId) {
      ctx.addIssue({
        code: "custom",
        path: ["carId"],
        message: "carId is required when scope is CAR",
      });
    }

    if (data.scope === "FLEET" && data.carId) {
      ctx.addIssue({
        code: "custom",
        path: ["carId"],
        message: "carId must be omitted when scope is FLEET",
      });
    }
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be on or after start date",
    path: ["endDate"],
  });

export type CreatePromotionBodyDto = z.infer<typeof createPromotionBodySchema>;

export const promotionIdParamSchema = z.cuid();
