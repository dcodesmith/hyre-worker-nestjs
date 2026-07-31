import { z } from "zod";

export const flutterwaveChargeWebhookDataSchema = z.looseObject({
  id: z.number().int().positive(),
  tx_ref: z.string().trim().min(1),
  flw_ref: z.string().trim().min(1),
  amount: z.number().nonnegative(),
  charged_amount: z.number().nonnegative(),
  currency: z.string().trim().min(1),
  status: z.string().trim().min(1),
  payment_type: z.string().trim().min(1),
  created_at: z.string().trim().min(1),
});

export const flutterwaveTransferWebhookDataSchema = z.looseObject({
  id: z.number().int().positive(),
  reference: z.string().trim().min(1),
  status: z.string().trim().min(1),
  complete_message: z.string().optional(),
});

export const flutterwaveRefundWebhookDataSchema = z.looseObject({
  id: z.number().int().positive(),
  AmountRefunded: z.number().nonnegative(),
  status: z.string().trim().min(1),
  FlwRef: z.string().trim().min(1),
  TransactionId: z.number().int().positive(),
  comments: z.string().nullish(),
});

const handledFlutterwaveWebhookPayloadSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("charge.completed"),
    data: flutterwaveChargeWebhookDataSchema,
  }),
  z.object({
    event: z.literal("transfer.completed"),
    data: flutterwaveTransferWebhookDataSchema,
  }),
  z.object({
    event: z.literal("refund.completed"),
    data: flutterwaveRefundWebhookDataSchema,
  }),
]);

const unknownFlutterwaveWebhookPayloadSchema = z
  .looseObject({
    event: z.string().trim().min(1),
    data: z.unknown().optional(),
  })
  .refine(
    ({ event }) =>
      event !== "charge.completed" &&
      event !== "transfer.completed" &&
      event !== "refund.completed",
    { path: ["event"], message: "Handled webhook events require a valid payload" },
  )
  .transform(({ event, data }) => ({
    event: "unknown" as const,
    originalEvent: event,
    data,
  }));

export const flutterwaveWebhookPayloadSchema = z.union([
  handledFlutterwaveWebhookPayloadSchema,
  unknownFlutterwaveWebhookPayloadSchema,
]);

export type FlutterwaveChargeWebhookData = z.infer<typeof flutterwaveChargeWebhookDataSchema>;
export type FlutterwaveTransferWebhookData = z.infer<typeof flutterwaveTransferWebhookDataSchema>;
export type FlutterwaveRefundWebhookData = z.infer<typeof flutterwaveRefundWebhookDataSchema>;
export type FlutterwaveWebhookPayload = z.infer<typeof flutterwaveWebhookPayloadSchema>;
