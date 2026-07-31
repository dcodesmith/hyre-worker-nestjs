ALTER TABLE "Payment"
ADD COLUMN "refundProviderId" TEXT,
ADD COLUMN "refundProviderStatus" TEXT,
ADD COLUMN "refundRequestedAmount" DECIMAL(10,2),
ADD COLUMN "refundRequestedAt" TIMESTAMP(3),
ADD COLUMN "refundLastCheckedAt" TIMESTAMP(3),
ADD COLUMN "refundReconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "refundVerificationFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "refundManualReviewNotifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Payment_refundProviderId_key" ON "Payment"("refundProviderId");

CREATE INDEX "Payment_status_refundRequestedAt_idx"
ON "Payment"("status", "refundRequestedAt");
