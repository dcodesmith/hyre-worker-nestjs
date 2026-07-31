CREATE TYPE "FinancialReconciliationResourceType" AS ENUM ('REFUND', 'PAYOUT');

CREATE TYPE "FinancialReconciliationOutcome" AS ENUM (
  'STARTED',
  'RECONCILED',
  'UNRESOLVED',
  'FAILED'
);

CREATE TABLE "FinancialReconciliationAudit" (
  "id" TEXT NOT NULL,
  "resourceType" "FinancialReconciliationResourceType" NOT NULL,
  "resourceId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "outcome" "FinancialReconciliationOutcome" NOT NULL DEFAULT 'STARTED',
  "providerReference" TEXT,
  "providerStatus" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FinancialReconciliationAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinancialRecon_resource_created_idx"
ON "FinancialReconciliationAudit"("resourceType", "resourceId", "createdAt");

CREATE INDEX "Payment_status_refundManualReviewNotifiedAt_idx"
ON "Payment"("status", "refundManualReviewNotifiedAt");

CREATE INDEX "PayoutTransaction_status_initiatedAt_idx"
ON "PayoutTransaction"("status", "initiatedAt");

CREATE UNIQUE INDEX "PayoutTransaction_payoutProviderReference_key"
ON "PayoutTransaction"("payoutProviderReference");

ALTER TABLE "PayoutTransaction"
ADD COLUMN "payoutBankCode" TEXT,
ADD COLUMN "payoutAccountLast4" TEXT;
