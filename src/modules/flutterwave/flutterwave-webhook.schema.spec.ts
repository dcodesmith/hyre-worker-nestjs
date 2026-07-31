import { describe, expect, it } from "vitest";
import { flutterwaveWebhookPayloadSchema } from "./flutterwave-webhook.schema";

describe("flutterwaveWebhookPayloadSchema", () => {
  it.each([
    {
      event: "charge.completed",
      data: {
        id: 1,
        tx_ref: "tx-123",
        flw_ref: "flw-123",
        amount: 1000,
        charged_amount: 1000,
        currency: "NGN",
        status: "successful",
        payment_type: "card",
        created_at: "2026-07-30T19:00:00.000Z",
      },
    },
    {
      event: "transfer.completed",
      data: {
        id: 2,
        reference: "payout-123",
        status: "SUCCESSFUL",
      },
    },
    {
      event: "refund.completed",
      data: {
        id: 3,
        AmountRefunded: 1000,
        status: "completed",
        FlwRef: "flw-123",
        TransactionId: 1,
      },
    },
  ])("accepts a valid $event payload", (payload) => {
    expect(flutterwaveWebhookPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    {
      event: "charge.completed",
      data: {
        id: 1,
        tx_ref: "",
        flw_ref: "flw-123",
        amount: 1000,
        charged_amount: 1000,
        currency: "NGN",
        status: "successful",
        payment_type: "card",
        created_at: "2026-07-30T19:00:00.000Z",
      },
    },
    {
      event: "transfer.completed",
      data: {
        id: 2,
        reference: "",
        status: "SUCCESSFUL",
      },
    },
    {
      event: "refund.completed",
      data: {
        id: 0,
        AmountRefunded: -1,
        status: "",
        FlwRef: "",
        TransactionId: 0,
      },
    },
  ])("rejects malformed $event data", (payload) => {
    expect(flutterwaveWebhookPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts unknown webhook events for acknowledgement", () => {
    const result = flutterwaveWebhookPayloadSchema.safeParse({
      event: "refund.pending",
      data: {},
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        event: "unknown",
        originalEvent: "refund.pending",
      },
    });
  });
});
