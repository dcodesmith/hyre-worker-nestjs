import { PaymentAttemptStatus, PayoutTransactionStatus } from "@prisma/client";
import { z } from "zod";

const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const attentionOnlySchema = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

export const adminRefundListQuerySchema = z.object({
  ...paginationSchema,
  attentionOnly: attentionOnlySchema,
  status: z
    .enum([
      PaymentAttemptStatus.REFUND_PROCESSING,
      PaymentAttemptStatus.REFUND_ERROR,
      PaymentAttemptStatus.REFUNDED,
      PaymentAttemptStatus.PARTIALLY_REFUNDED,
      PaymentAttemptStatus.REFUND_FAILED,
    ])
    .optional(),
});

export const adminPayoutListQuerySchema = z.object({
  ...paginationSchema,
  attentionOnly: attentionOnlySchema,
  status: z.enum(PayoutTransactionStatus).optional(),
});

export const financialOperationIdSchema = z.cuid();

export const reconcileRefundBodySchema = z.object({
  refundProviderId: z.string().trim().min(1).optional(),
});

export type AdminRefundListQueryDto = z.infer<typeof adminRefundListQuerySchema>;
export type AdminPayoutListQueryDto = z.infer<typeof adminPayoutListQuerySchema>;
export type ReconcileRefundBodyDto = z.infer<typeof reconcileRefundBodySchema>;
