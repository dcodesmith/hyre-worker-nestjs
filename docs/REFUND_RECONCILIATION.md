# Refund reconciliation

Refund initiation reserves the payment and its booking or extension before calling Flutterwave:

- `SUCCESSFUL` becomes `REFUND_PROCESSING`.
- Provider or persistence uncertainty becomes `REFUND_ERROR`.
- `REFUNDED`, `PARTIALLY_REFUNDED`, and `REFUND_FAILED` are terminal.

The refund webhook is the primary completion signal. Before finalizing a successful refund, the
service calls `GET /v3/refunds/:id` to verify the provider refund ID, original transaction, amount,
and terminal status. Scheduled reconciliation provides the same verification when a webhook is
missed. An explicit rejection returned during initiation is finalized immediately.

## Automated reconciliation

`PaymentReconciliationService` checks unresolved refunds hourly. It waits at least 15 minutes
after initiation and processes up to 50 refunds per run.

Provider statuses are handled as follows:

- `completed-bank-transfer`, `completed-momo`, `completed-mpgs`, `completed-offline`, and
  `completed-preauth`: successful.
- `completed`, `pending-momo`, and `processing`: still pending.
- `failed`, `cancelled`, and `rejected`: failed.
- Unknown statuses: retried before operations handoff.

Expected completion windows include a safety margin:

- Bank account: 48 hours.
- Mobile money: 6 days.
- Card or unknown method: 16 days.

## Manual operations handoff

Operations receives one email when:

- The provider refund ID is unavailable.
- The refund belongs to another transaction or has an invalid amount.
- Provider verification fails three consecutive times.
- Flutterwave returns an unknown status three times.
- A pending refund exceeds its expected completion window.

Once handed off, the refund is excluded from automated reconciliation.

## Manual review steps

1. Find the payment by `paymentId`, `txRef`, or `flutterwaveTransactionId`.
2. Compare `refundProviderId`, `refundRequestedAmount`, and the original charged amount.
3. Fetch the refund in Flutterwave and verify its transaction ID, amount, and status.
4. Confirm whether the customer received the funds.
5. Correct the local payment and booking or extension statuses together.
6. Record the investigation outcome in the operations incident or support ticket.

Do not initiate another refund while the payment is `REFUND_PROCESSING` or `REFUND_ERROR`.

## Flutterwave references

- https://developer.flutterwave.com/v3.0/docs/refunds
- https://developer.flutterwave.com/v3.0/reference/get-transaction-refunds
- https://developer.flutterwave.com/v3.0/docs/webhooks
