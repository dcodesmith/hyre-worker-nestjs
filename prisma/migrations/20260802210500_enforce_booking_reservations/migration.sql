-- Track the authoritative Flutterwave checkout expiry for pending reservations.
ALTER TABLE "Booking"
ADD COLUMN "paymentSessionExpiresAt" TIMESTAMP(3);

CREATE INDEX "Booking_status_paymentStatus_paymentSessionExpiresAt_idx"
ON "Booking"("status", "paymentStatus", "paymentSessionExpiresAt");

-- btree_gist lets PostgreSQL combine car equality with time-range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_valid_window_check"
CHECK ("startDate" < "endDate");

-- PENDING bookings are reservations. They remain blocking until the application
-- explicitly confirms or cancels them after reconciling their payment status.
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
