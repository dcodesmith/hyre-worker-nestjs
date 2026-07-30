-- Payout dispatch is at-least-once. One payout transaction per booking is the
-- database idempotency boundary before calling the external provider.
DO $$
DECLARE
  duplicate_booking_id TEXT;
BEGIN
  SELECT "bookingId"
  INTO duplicate_booking_id
  FROM "PayoutTransaction"
  WHERE "bookingId" IS NOT NULL
  GROUP BY "bookingId"
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF duplicate_booking_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot restore payout idempotency: duplicate PayoutTransaction rows exist for bookingId %',
      duplicate_booking_id;
  END IF;
END $$;

-- Remove an invalid or incorrectly non-unique same-name index before rebuilding.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index index_state
    JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'PayoutTransaction_bookingId_key'
      AND (NOT index_state.indisvalid OR NOT index_state.indisunique)
  ) THEN
    DROP INDEX "PayoutTransaction_bookingId_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "PayoutTransaction_bookingId_key"
ON "PayoutTransaction"("bookingId");

DROP INDEX IF EXISTS "PayoutTransaction_bookingId_idx";
