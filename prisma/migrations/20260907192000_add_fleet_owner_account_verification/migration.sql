CREATE TYPE "FleetOwnerAccountType" AS ENUM ('INDIVIDUAL', 'BUSINESS');
CREATE TYPE "AccountVerificationStatus" AS ENUM (
  'PROCESSING',
  'SUCCEEDED',
  'REVIEW_REQUIRED',
  'FAILED'
);
CREATE TYPE "NameMatchStatus" AS ENUM ('MATCHED', 'REVIEW_REQUIRED', 'MISMATCHED');

ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

-- Preserve access for fleet owners already approved under the previous manual process.
UPDATE "User"
SET "phoneVerifiedAt" = "updatedAt"
WHERE "fleetOwnerStatus" = 'APPROVED'
  AND "hasOnboarded" = true
  AND "phoneNumber" IS NOT NULL;

CREATE TABLE "FleetOwnerAccountVerification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "accountType" "FleetOwnerAccountType" NOT NULL,
  "isOwnerDriver" BOOLEAN NOT NULL,
  "status" "AccountVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
  "processingExpiresAt" TIMESTAMP(3) NOT NULL,
  "legalName" TEXT,
  "businessName" TEXT,
  "businessNameMatch" "NameMatchStatus",
  "registrationNumber" TEXT,
  "registrationType" TEXT,
  "identityProviderRef" TEXT,
  "businessProviderRef" TEXT,
  "bankName" TEXT,
  "bankCode" TEXT,
  "accountNumberLast4" TEXT,
  "accountName" TEXT,
  "bankNameMatch" "NameMatchStatus",
  "representativeNameMatch" "NameMatchStatus",
  "failureReason" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FleetOwnerAccountVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FleetOwnerAccountVerification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FleetOwnerAccountVerification_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FleetOwnerAccountVerification_userId_idempotencyKey_key"
  ON "FleetOwnerAccountVerification"("userId", "idempotencyKey");
CREATE INDEX "FleetOwnerAccountVerification_userId_createdAt_idx"
  ON "FleetOwnerAccountVerification"("userId", "createdAt");
CREATE INDEX "FleetOwnerAccountVerification_status_createdAt_idx"
  ON "FleetOwnerAccountVerification"("status", "createdAt");
CREATE INDEX "FleetOwnerAccountVerification_reviewedById_idx"
  ON "FleetOwnerAccountVerification"("reviewedById");
CREATE UNIQUE INDEX "FleetOwnerAccountVerification_one_active_per_user_idx"
  ON "FleetOwnerAccountVerification"("userId")
  WHERE "status" IN ('PROCESSING', 'REVIEW_REQUIRED');
