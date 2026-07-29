CREATE INDEX CONCURRENTLY "ReferralReward_status_releaseCondition_reconciliationLastAttemptAt_createdAt_idx"
ON "ReferralReward"("status", "releaseCondition", "reconciliationLastAttemptAt", "createdAt");
