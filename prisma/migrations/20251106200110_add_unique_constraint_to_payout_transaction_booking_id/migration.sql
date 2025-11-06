-- AlterTable: Add UNIQUE constraint on PayoutTransaction.bookingId
-- This prevents duplicate payout transactions for the same booking

-- First, verify no duplicates exist (should pass based on our check)
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "bookingId"
    FROM "PayoutTransaction"
    WHERE "bookingId" IS NOT NULL
    GROUP BY "bookingId"
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Cannot add unique constraint: % duplicate bookingId values found', duplicate_count;
  END IF;
END $$;

-- Add the unique constraint
CREATE UNIQUE INDEX "PayoutTransaction_bookingId_key" ON "PayoutTransaction"("bookingId");
