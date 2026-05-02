import { z } from "zod";

export const resolvePlaceBodySchema = z.object({
  placeId: z.string().trim().min(1, "placeId is required").max(256, "placeId is too long"),
  sessionToken: z.string().trim().min(1).max(128).optional(),
});

export type ResolvePlaceBodyDto = z.infer<typeof resolvePlaceBodySchema>;
