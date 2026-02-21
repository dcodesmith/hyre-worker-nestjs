import { z } from "zod";

export const aiSearchBodySchema = z.object({
  query: z.string().trim().min(1, "Query is required"),
});

export type AiSearchBodyDto = z.infer<typeof aiSearchBodySchema>;

export const extractedAiSearchParamsSchema = z
  .object({
    color: z.string().optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    vehicleType: z
      .enum(["SEDAN", "SUV", "LUXURY_SEDAN", "LUXURY_SUV", "VAN", "CROSSOVER"])
      .optional(),
    serviceTier: z.enum(["STANDARD", "EXECUTIVE", "LUXURY", "ULTRA_LUXURY"]).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    bookingType: z.enum(["DAY", "NIGHT", "FULL_DAY", "AIRPORT_PICKUP"]).optional(),
    pickupTime: z.string().optional(),
    flightNumber: z.string().optional(),
  })
  .strict();
