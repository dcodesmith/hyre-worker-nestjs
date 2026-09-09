ALTER TYPE "AccountVerificationStatus" ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'PROCESSING';

CREATE TYPE "AccountVerificationStage" AS ENUM ('PAYOUT', 'DRIVING', 'SUBMISSION');

ALTER TABLE "FleetOwnerAccountVerification"
  ALTER COLUMN "isOwnerDriver" DROP NOT NULL,
  ADD COLUMN "identityFirstName" TEXT,
  ADD COLUMN "identityLastName" TEXT,
  ADD COLUMN "identityRequiresReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "identityVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "payoutVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "drivingCompletedAt" TIMESTAMP(3),
  ADD COLUMN "submittedAt" TIMESTAMP(3);

CREATE TABLE "FleetOwnerAccountVerificationStageRequest" (
  "id" TEXT NOT NULL,
  "verificationId" TEXT NOT NULL,
  "stage" "AccountVerificationStage" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
  "failureReason" TEXT,
  "response" JSONB,
  "processingExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FleetOwnerAccountVerificationStageRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FleetOwnerAccountVerificationStageRequest_verificationId_fkey"
    FOREIGN KEY ("verificationId")
    REFERENCES "FleetOwnerAccountVerification"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FleetOwnerAccountVerificationStageRequest_verificationId_idempotencyKey_key"
  ON "FleetOwnerAccountVerificationStageRequest"("verificationId", "idempotencyKey");
CREATE UNIQUE INDEX "FleetOwnerAccountVerificationStageRequest_one_processing_per_stage_idx"
  ON "FleetOwnerAccountVerificationStageRequest"("verificationId", "stage")
  WHERE "status" = 'PROCESSING';
CREATE INDEX "FleetOwnerAccountVerificationStageRequest_verificationId_stage_createdAt_idx"
  ON "FleetOwnerAccountVerificationStageRequest"("verificationId", "stage", "createdAt");
CREATE INDEX "FleetOwnerAccountVerificationStageRequest_status_processingExpiresAt_idx"
  ON "FleetOwnerAccountVerificationStageRequest"("status", "processingExpiresAt");

DROP INDEX "FleetOwnerAccountVerification_one_active_per_user_idx";
CREATE UNIQUE INDEX "FleetOwnerAccountVerification_one_active_per_user_idx"
  ON "FleetOwnerAccountVerification"("userId")
  WHERE "status" IN ('DRAFT', 'PROCESSING', 'REVIEW_REQUIRED');
