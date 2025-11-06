-- Drop the redundant non-unique index on PayoutTransaction.bookingId
-- The unique index "PayoutTransaction_bookingId_key" already provides the same functionality

DROP INDEX IF EXISTS "PayoutTransaction_bookingId_idx";
