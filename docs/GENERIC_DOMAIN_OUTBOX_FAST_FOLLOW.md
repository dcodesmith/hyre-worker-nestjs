# Generic Domain Outbox Fast Follow

## Status

Implemented on `feat/domain-outbox`. The domain outbox is the sole durable path
for referral completion and payout processing.

## Flow

Inside the booking-completion transaction:

1. Mark the booking `COMPLETED`.
2. Insert one typed `REFERRAL_COMPLETION` delivery.
3. Insert one typed `PAYOUT_PROCESSING` delivery.
4. Commit all three changes atomically.

A dispatcher claims pending deliveries and adds attempt-specific BullMQ jobs.
Redis acceptance marks a delivery `DISPATCHED`; the worker marks it `COMPLETED`
only after the business operation succeeds. Terminal worker failures return to
the durable retry loop, and stale dispatched deliveries are redriven.

Use separate referral and payout deliveries so one successful enqueue is not
repeated when the other fails. Delivery is at-least-once, so BullMQ job IDs and
consumers must remain idempotent.

Before calling Flutterwave, a payout worker atomically claims a short database
lease on the booking's payout transaction. Concurrent or stale-redriven workers
cannot call the provider while that lease is active, and lease ownership fences
late success or failure writes. Provider calls retain a deterministic reference,
and an expired lease is reconciled by that reference before another transfer is
initiated. Accepted transfers that remain `PROCESSING` are reconciled hourly by
provider reference after a grace period, so a lost completion webhook cannot
leave a payout permanently unresolved.

## Why this is separate from the notification outbox

The existing notification outbox stores `NotificationJobData`, creates inbox
rows, and dispatches only to the notification queue. Domain work needs its own
generic event contract and dispatcher rather than weakening that boundary.

## Verification

Verify at least one complete booking lifecycle after applying the migrations.

Check delivery health:

```sql
SELECT "eventType", status, COUNT(*)
FROM "DomainOutboxEvent"
GROUP BY "eventType", status
ORDER BY "eventType", status;
```

Inspect incomplete deliveries without exposing customer data:

```sql
SELECT id, "eventType", status, attempts, "aggregateId",
       "nextAttemptAt", "lastError", "updatedAt"
FROM "DomainOutboxEvent"
WHERE status <> 'COMPLETED'
ORDER BY "createdAt";
```

Confirm payout idempotency remains intact:

```sql
SELECT "bookingId", COUNT(*)
FROM "PayoutTransaction"
WHERE "bookingId" IS NOT NULL
GROUP BY "bookingId"
HAVING COUNT(*) > 1;
```

Success criteria:

- No unexplained `FAILED`, stale `PROCESSING`/`DISPATCHED`, or `DEAD_LETTER`
  deliveries.
- New completed bookings produce one completed referral delivery and one
  completed payout delivery.
- Referral rewards still release exactly once.
- Each booking creates at most one payout transaction.
- Bull Board and application logs show the deterministic jobs being accepted
  and processed.

