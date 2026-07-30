-- A nullable lease fences concurrent workers while a payout request is in flight.
-- Existing rows remain unchanged and continue to represent accepted or terminal payouts.
ALTER TABLE "PayoutTransaction"
ADD COLUMN "processingLeaseId" TEXT,
ADD COLUMN "processingLeaseExpiresAt" TIMESTAMP(3);
