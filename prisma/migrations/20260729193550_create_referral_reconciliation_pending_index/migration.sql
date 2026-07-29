CREATE INDEX CONCURRENTLY "ReferralReward_reconciliation_pending_idx"
ON "ReferralReward"(
  "status",
  "releaseCondition",
  "reconciliationLastAttemptAt" ASC NULLS FIRST,
  "createdAt" ASC
);
