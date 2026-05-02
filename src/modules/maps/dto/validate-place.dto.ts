import { z } from "zod";

export const validatePlaceBodySchema = z.object({
  input: z
    .string()
    .trim()
    .min(2, "Input must be at least 2 characters")
    .max(120, "Input must be at most 120 characters"),
});

export type ValidatePlaceBodyDto = z.infer<typeof validatePlaceBodySchema>;
