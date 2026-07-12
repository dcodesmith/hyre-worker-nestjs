import { CarApprovalStatus } from "@prisma/client";
import { z } from "zod";

export const imageIdParamSchema = z.cuid();
export const documentIdParamSchema = z.cuid();

export const listCarsForReviewQuerySchema = z.object({
  approvalStatus: z.enum(CarApprovalStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListCarsForReviewQueryDto = z.infer<typeof listCarsForReviewQuerySchema>;

export const rejectBodySchema = z.object({
  notes: z.string().trim().min(1, "A rejection reason is required"),
});
export type RejectBodyDto = z.infer<typeof rejectBodySchema>;

export const setCoverBodySchema = z.object({
  imageId: z.cuid(),
});
export type SetCoverBodyDto = z.infer<typeof setCoverBodySchema>;
