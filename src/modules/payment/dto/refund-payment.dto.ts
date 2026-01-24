import { z } from "zod";

export const refundPaymentSchema = z.object({
  amount: z.number().min(100, "Minimum refund amount is 100 NGN"),
  reason: z.string().optional(),
});

export type RefundPaymentDto = z.infer<typeof refundPaymentSchema>;
