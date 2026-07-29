# Generic Domain Outbox Fast Follow

## Problem

Booking completion commits in PostgreSQL before referral and payout jobs are
added to Redis. If either enqueue fails, the booking remains completed but the
post-completion work can be stranded.

## Proposed flow

Inside the booking-completion transaction:

1. Mark the booking `COMPLETED`.
2. Insert one domain-outbox delivery for referral processing.
3. Insert one domain-outbox delivery for payout processing.
4. Commit all three changes atomically.

A dispatcher claims pending deliveries and adds deterministic BullMQ jobs. It
marks each delivery dispatched only after Redis accepts the job, with retry,
backoff, dead-letter state, and operational logging.

Use separate referral and payout deliveries so one successful enqueue is not
repeated when the other fails. Delivery is at-least-once, so BullMQ job IDs and
consumers must remain idempotent.

## Why this is separate from the notification outbox

The existing notification outbox stores `NotificationJobData`, creates inbox
rows, and dispatches only to the notification queue. Domain work needs its own
generic event contract and dispatcher rather than weakening that boundary.

## Follow-up PR scope

- Add a `DomainOutboxEvent` model and safe migration.
- Record referral and payout deliveries in the booking-completion transaction.
- Add claim locking, retry/backoff, stale-claim recovery, and dead-letter state.
- Dispatch deterministic jobs to the referral and payout queues.
- Add unit and E2E coverage for partial fan-out, Redis failure, retries, and
  duplicate dispatch.
- Remove the temporary referral reconciler after rollout is verified.

