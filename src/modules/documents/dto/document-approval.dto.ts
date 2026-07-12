import { z } from "zod";

export const rejectBodySchema = z.object({
  notes: z.string().trim().min(1, "A rejection reason is required"),
});

export type RejectBodyDto = z.infer<typeof rejectBodySchema>;
