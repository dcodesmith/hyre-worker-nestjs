import { z } from "zod";
import { callbackUrlSchema } from "../../../common/validation/callback-url";

export const initializePaymentSchema = z.object({
  type: z.enum(["booking", "extension"]),
  entityId: z.uuid("Invalid entity ID format"),
  amount: z.number().min(100, "Minimum amount is 100 NGN"),
  callbackUrl: callbackUrlSchema,
});

export type InitializePaymentDto = z.infer<typeof initializePaymentSchema>;
