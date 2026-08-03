-- Track the authoritative Flutterwave checkout expiry for pending reservations.
ALTER TABLE "Booking"
ADD COLUMN IF NOT EXISTS "paymentSessionExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Booking_status_paymentStatus_paymentSessionExpiresAt_idx"
ON "Booking"("status", "paymentStatus", "paymentSessionExpiresAt");

-- btree_gist lets PostgreSQL combine car equality with time-range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Legacy status jobs may have missed historical bookings. Normalize only
-- bookings whose buffered windows have already ended so old overlaps do not
-- prevent the constraint from being installed. Future overlaps still fail the
-- migration and require explicit operational reconciliation.
UPDATE "Booking"
SET
  "status" = CASE
    WHEN "status" = 'PENDING'::"BookingStatus"
      AND "paymentStatus" <> 'PAID'::"PaymentStatus"
      THEN 'CANCELLED'::"BookingStatus"
    ELSE 'COMPLETED'::"BookingStatus"
  END,
  "cancelledAt" = CASE
    WHEN "status" = 'PENDING'::"BookingStatus"
      AND "paymentStatus" <> 'PAID'::"PaymentStatus"
      THEN COALESCE("cancelledAt", timezone('UTC', clock_timestamp()))
    ELSE "cancelledAt"
  END,
  "cancellationReason" = CASE
    WHEN "status" = 'PENDING'::"BookingStatus"
      AND "paymentStatus" <> 'PAID'::"PaymentStatus"
      THEN COALESCE(
        "cancellationReason",
        'Expired legacy reservation normalized before overlap enforcement'
      )
    ELSE "cancellationReason"
  END,
  "updatedAt" = timezone('UTC', clock_timestamp())
WHERE
  "deletedAt" IS NULL
  AND "status" IN (
    'PENDING'::"BookingStatus",
    'CONFIRMED'::"BookingStatus",
    'ACTIVE'::"BookingStatus"
  )
  AND "endDate" + INTERVAL '2 hours' <= timezone('UTC', clock_timestamp());

-- Enforce valid windows for all new and changed rows without blocking deployment
-- on malformed legacy history. Existing invalid rows can be audited and the
-- constraint validated in a follow-up migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Booking_valid_window_check'
      AND conrelid = '"Booking"'::regclass
  ) THEN
    ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_valid_window_check"
    CHECK ("startDate" < "endDate") NOT VALID;
  END IF;
END
$$;

-- PENDING bookings are reservations. They remain blocking until the application
-- explicitly confirms or cancels them after reconciling their payment status.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Booking_car_active_window_excl'
      AND conrelid = '"Booking"'::regclass
  ) THEN
    ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_car_active_window_excl"
    EXCLUDE USING gist (
      "carId" WITH =,
      tsrange(
        LEAST("startDate" - INTERVAL '2 hours', "endDate" + INTERVAL '2 hours'),
        GREATEST("startDate" - INTERVAL '2 hours', "endDate" + INTERVAL '2 hours'),
        '[)'
      ) WITH &&
    )
    WHERE (
      "deletedAt" IS NULL
      AND "status" IN (
        'PENDING'::"BookingStatus",
        'CONFIRMED'::"BookingStatus",
        'ACTIVE'::"BookingStatus"
      )
    );
  END IF;
END
$$;
