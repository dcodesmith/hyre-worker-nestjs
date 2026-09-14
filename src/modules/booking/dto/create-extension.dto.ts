import { z } from "zod";
import { callbackUrlSchema } from "../../../common/validation/callback-url";

export const createExtensionBodySchema = z.object({
  hours: z.coerce.number().int().min(1).max(24),
  callbackUrl: callbackUrlSchema,
  bookingLegId: z.uuid("Booking leg ID must be a valid UUID").optional(),
});

export type CreateExtensionBodyDto = z.infer<typeof createExtensionBodySchema>;

export const bookingIdParamSchema = z.uuid("Booking ID must be a valid UUID");
