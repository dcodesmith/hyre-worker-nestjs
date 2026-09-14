import { z } from "zod";

export const assignBookingChauffeurBodySchema = z.object({
  chauffeurId: z.uuid("Chauffeur ID must be a valid UUID"),
});

export type AssignBookingChauffeurBodyDto = z.infer<typeof assignBookingChauffeurBodySchema>;
