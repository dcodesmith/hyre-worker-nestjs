DROP INDEX IF EXISTS "ReferralReward_reconciliation_pending_idx";

ALTER TABLE "ReferralReward"
DROP COLUMN IF EXISTS "reconciliationLastAttemptAt";
