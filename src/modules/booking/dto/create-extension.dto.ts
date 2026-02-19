import { z } from "zod";

export const createExtensionBodySchema = z.object({
  hours: z.coerce.number().int().min(1).max(24),
  callbackUrl: z.url(),
});

export type CreateExtensionBodyDto = z.infer<typeof createExtensionBodySchema>;

export const bookingIdParamSchema = z.string().min(1);
