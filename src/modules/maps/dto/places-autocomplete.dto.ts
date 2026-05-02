import { z } from "zod";

export const placesAutocompleteQuerySchema = z.object({
  input: z
    .string()
    .trim()
    .min(2, "Input must be at least 2 characters")
    .max(120, "Input must be at most 120 characters"),
  sessionToken: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(8).default(4),
});

export type PlacesAutocompleteQueryDto = z.infer<typeof placesAutocompleteQuerySchema>;
