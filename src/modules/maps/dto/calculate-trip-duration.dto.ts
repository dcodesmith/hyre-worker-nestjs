import { z } from "zod";

export const calculateTripDurationQuerySchema = z.object({
  destination: z.string().trim().min(1, "Destination address is required"),
});

export type CalculateTripDurationQueryDto = z.infer<typeof calculateTripDurationQuerySchema>;
