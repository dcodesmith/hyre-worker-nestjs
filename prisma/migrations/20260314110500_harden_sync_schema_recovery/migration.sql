-- Defensive follow-up migration for partially-applied index/default changes.
-- This migration is intentionally idempotent and non-destructive to table data.

-- Keep only the intended non-unique index for payout transaction booking lookups.
DROP INDEX IF EXISTS "PayoutTransaction_bookingId_key";

DO $$
BEGIN
  IF to_regclass('"PayoutTransaction"') IS NOT NULL
     AND to_regclass('"PayoutTransaction_bookingId_idx"') IS NULL THEN
    EXECUTE 'CREATE INDEX "PayoutTransaction_bookingId_idx" ON "PayoutTransaction"("bookingId")';
  END IF;
END $$;

-- Ensure this column no longer has a default.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Car'
      AND column_name = 'airportPickupRate'
      AND column_default IS NOT NULL
  ) THEN
    EXECUTE 'ALTER TABLE "Car" ALTER COLUMN "airportPickupRate" DROP DEFAULT';
  END IF;
END $$;

-- Ensure expected supporting indexes exist for Flight and Session.
DO $$
BEGIN
  IF to_regclass('"Flight"') IS NOT NULL
     AND to_regclass('"Flight_flightNumber_flightDate_idx"') IS NULL THEN
    EXECUTE 'CREATE INDEX "Flight_flightNumber_flightDate_idx" ON "Flight"("flightNumber", "flightDate")';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"Flight"') IS NOT NULL
     AND to_regclass('"Flight_alertId_idx"') IS NULL THEN
    EXECUTE 'CREATE INDEX "Flight_alertId_idx" ON "Flight"("alertId")';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"session"') IS NOT NULL
     AND to_regclass('"session_token_idx"') IS NULL THEN
    EXECUTE 'CREATE INDEX "session_token_idx" ON "session"("token")';
  END IF;
END $$;

-- Ensure dedupe uniqueness for status events when safe to enforce.
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  IF to_regclass('"FlightStatusEvent"') IS NOT NULL
     AND to_regclass('"FlightStatusEvent_flightId_eventType_eventTime_key"') IS NULL THEN
    SELECT COUNT(*) INTO duplicate_count
    FROM (
      SELECT "flightId", "eventType", "eventTime"
      FROM "FlightStatusEvent"
      GROUP BY "flightId", "eventType", "eventTime"
      HAVING COUNT(*) > 1
    ) duplicates;

    IF duplicate_count > 0 THEN
      RAISE WARNING 'Skipping unique index FlightStatusEvent_flightId_eventType_eventTime_key: % duplicate key groups found', duplicate_count;
    ELSE
      EXECUTE 'CREATE UNIQUE INDEX "FlightStatusEvent_flightId_eventType_eventTime_key" ON "FlightStatusEvent"("flightId", "eventType", "eventTime")';
    END IF;
  END IF;
END $$;
