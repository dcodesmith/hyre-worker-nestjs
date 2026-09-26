import { VerificationInterventionStatus } from "@prisma/client";
import { z } from "zod";

export const interventionIdSchema = z.uuid();

export const listInterventionsSchema = z.object({
  status: z.nativeEnum(VerificationInterventionStatus).default(VerificationInterventionStatus.OPEN),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const approveInterventionSchema = z.object({
  notes: z.string().trim().min(3).max(2000),
  source: z.string().trim().min(2).max(120),
  authoritativeSourceAttested: z.boolean().default(false),
});

export const rejectInterventionSchema = z.object({
  notes: z.string().trim().min(3).max(2000),
});

export type ListInterventionsDto = z.infer<typeof listInterventionsSchema>;
export type ApproveInterventionDto = z.infer<typeof approveInterventionSchema>;
export type RejectInterventionDto = z.infer<typeof rejectInterventionSchema>;
