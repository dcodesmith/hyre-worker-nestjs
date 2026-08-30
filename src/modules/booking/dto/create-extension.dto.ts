import { z } from "zod";
import { callbackUrlSchema } from "../../../common/validation/callback-url";

export const createExtensionBodySchema = z.object({
  hours: z.coerce.number().int().min(1).max(24),
  callbackUrl: callbackUrlSchema,
  bookingLegId: z.string().min(1).optional(),
});

export type CreateExtensionBodyDto = z.infer<typeof createExtensionBodySchema>;

export const bookingIdParamSchema = z.string().min(1);
