-- The previous constraint buffered both sides of every booking by two hours,
-- which required a four-hour gap between consecutive bookings. Extending only
-- the end enforces the intended total two-hour turnaround gap.
BEGIN;

ALTER TABLE "Booking"
DROP CONSTRAINT "Booking_car_active_window_excl";

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_car_active_window_excl"
EXCLUDE USING gist (
  "carId" WITH =,
  tsrange(
    "startDate",
    "endDate" + INTERVAL '2 hours',
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

COMMIT;
