import { z } from "zod";

export const assignBookingChauffeurBodySchema = z.object({
  chauffeurId: z.string().min(1, "Chauffeur ID is required"),
});

export type AssignBookingChauffeurBodyDto = z.infer<typeof assignBookingChauffeurBodySchema>;
