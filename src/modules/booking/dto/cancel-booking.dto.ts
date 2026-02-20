import { z } from "zod";

export const cancelBookingBodySchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
});

export type CancelBookingBodyDto = z.infer<typeof cancelBookingBodySchema>;
