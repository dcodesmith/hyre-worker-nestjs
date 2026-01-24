import { z } from "zod";

// CUID pattern: starts with 'c', followed by 24 alphanumeric characters
const cuidPattern = /^c[a-z0-9]{24}$/;

export const initializePaymentSchema = z.object({
  type: z.enum(["booking", "extension"]),
  entityId: z.string().regex(cuidPattern, "Invalid entity ID format"),
  amount: z.number().min(100, "Minimum amount is 100 NGN"),
  callbackUrl: z.string().url("Invalid callback URL"),
});

export type InitializePaymentDto = z.infer<typeof initializePaymentSchema>;
