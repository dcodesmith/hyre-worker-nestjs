import { z } from "zod";

const staffStatusSchema = z.enum(["active", "revoked"]);

export const listStaffQuerySchema = z.object({
  status: staffStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListStaffQueryDto = z.infer<typeof listStaffQuerySchema>;

export const staffIdParamSchema = z.cuid();
