import { z } from "zod";

export const calculateTripDurationQuerySchema = z.object({
  destination: z.string().trim().min(1, "Destination address is required"),
  origin: z.string().trim().min(1, "Origin address is required").optional(),
  arrivalTime: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Invalid date format",
    })
    .optional(),
});

export type CalculateTripDurationQueryDto = z.infer<typeof calculateTripDurationQuerySchema>;
