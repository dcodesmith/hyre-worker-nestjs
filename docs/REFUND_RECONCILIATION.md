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
# Refund reconciliation

Refunds are reconciled hourly against Flutterwave V3 using the persisted refund ID. A successful
refund is only finalized for the documented terminal statuses:

- `completed-bank-transfer`
- `completed-momo`
- `completed-mpgs`
- `completed-offline`
- `completed-preauth`

Flutterwave's plain `completed` status means that the refund was initiated and is still awaiting
disbursement. It must not trigger a customer success notification.

## Operations handoff

Operations receives one durable email while automated reconciliation continues when:

- an uncertain initiation has no refund ID after 15 minutes;
- three consecutive provider lookups fail;
- Flutterwave returns an unrecognized status three consecutive times;
- the provider refund transaction or amount does not match the local payment; or
- the refund remains pending beyond 48 hours for bank transfers, 6 days for mobile money, or
  16 days for cards and unknown payment methods.

The email includes the booking reference, payment ID, refund ID when available, amount, and reason.
Operations should:

1. Locate the payment and refund in the Flutterwave dashboard.
2. Confirm the refund ID, original transaction ID, amount, and current status.
3. Never initiate another refund until Flutterwave confirms that no refund exists for the payment.
4. If Flutterwave's API returns a documented terminal status, allow the next hourly reconciliation
   pass to finalize it.
5. If the dashboard and API disagree or the refund remains unresolved, escalate to Flutterwave
   support and engineering. Do not update only the `Payment` row because refund finalization also
   synchronizes the booking or extension and writes the notification outbox atomically.

Flutterwave references:

- https://developer.flutterwave.com/v3.0/docs/refunds
- https://developer.flutterwave.com/v3.0/reference/get-transaction-refunds
- https://developer.flutterwave.com/v3.0/docs/webhooks
