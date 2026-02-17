import { z } from "zod";

const cuidPattern = /^c[a-z0-9]{24}$/;

const ratingSchema = z.number().int().min(1).max(5);

export const createReviewSchema = z.object({
  bookingId: z.string().regex(cuidPattern, "Invalid booking ID format"),
  overallRating: ratingSchema,
  carRating: ratingSchema,
  chauffeurRating: ratingSchema,
  serviceRating: ratingSchema,
  comment: z.string().trim().max(2000).optional(),
});

export type CreateReviewDto = z.infer<typeof createReviewSchema>;

export const updateReviewSchema = z
  .object({
    overallRating: ratingSchema.optional(),
    carRating: ratingSchema.optional(),
    chauffeurRating: ratingSchema.optional(),
    serviceRating: ratingSchema.optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (value) =>
      value.overallRating !== undefined ||
      value.carRating !== undefined ||
      value.chauffeurRating !== undefined ||
      value.serviceRating !== undefined ||
      value.comment !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

export type UpdateReviewDto = z.infer<typeof updateReviewSchema>;

export const hideReviewSchema = z.object({
  moderationNotes: z.string().trim().max(500).optional(),
});

export type HideReviewDto = z.infer<typeof hideReviewSchema>;

export const reviewIdParamSchema = z.string().regex(cuidPattern, "Invalid review ID format");
export const bookingIdParamSchema = z.string().regex(cuidPattern, "Invalid booking ID format");
export const carIdParamSchema = z.string().regex(cuidPattern, "Invalid car ID format");
export const chauffeurIdParamSchema = z.string().regex(cuidPattern, "Invalid chauffeur ID format");

export const reviewQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  includeRatings: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((value) => {
      if (typeof value === "boolean") return value;
      return value === "true";
    })
    .default(false),
});

export type ReviewQueryDto = z.infer<typeof reviewQuerySchema>;
