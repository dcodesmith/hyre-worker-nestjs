CREATE TYPE "VerificationDecisionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "VerificationInterventionKind" AS ENUM (
  'CHAUFFEUR_DRIVERS_LICENSE',
  'OWNER_DRIVER_LICENSE',
  'CHAUFFEUR_FACE'
);
CREATE TYPE "VerificationInterventionStatus" AS ENUM (
  'OPEN',
  'AUTO_RESOLVED',
  'APPROVED',
  'REJECTED'
);

ALTER TABLE "ChauffeurVerification"
ADD COLUMN "driversLicenseDecision" "VerificationDecisionStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "faceDecision" "VerificationDecisionStatus" NOT NULL DEFAULT 'PENDING';

ALTER TABLE "FleetOwnerAccountVerification"
ADD COLUMN "driversLicenseDecision" "VerificationDecisionStatus" NOT NULL DEFAULT 'PENDING';

UPDATE "ChauffeurVerification"
SET "driversLicenseDecision" = 'APPROVED'
WHERE "driversLicenseProviderRef" IS NOT NULL;

UPDATE "ChauffeurVerification"
SET "faceDecision" = 'APPROVED'
WHERE "status" = 'APPROVED';

UPDATE "FleetOwnerAccountVerification"
SET "driversLicenseDecision" = 'APPROVED'
WHERE "driversLicenseProviderRef" IS NOT NULL;

CREATE TABLE "VerificationIntervention" (
  "id" UUID NOT NULL,
  "resourceKey" TEXT NOT NULL,
  "kind" "VerificationInterventionKind" NOT NULL,
  "status" "VerificationInterventionStatus" NOT NULL DEFAULT 'OPEN',
  "chauffeurVerificationId" UUID,
  "accountVerificationId" UUID,
  "documentApprovalId" UUID,
  "encryptedPayload" TEXT,
  "retryAttempt" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "emailNotifiedAt" TIMESTAMP(3),
  "resolutionSource" TEXT,
  "resolutionNotes" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VerificationIntervention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VerificationIntervention_resourceKey_key"
ON "VerificationIntervention"("resourceKey");
CREATE INDEX "VerificationIntervention_status_createdAt_idx"
ON "VerificationIntervention"("status", "createdAt");
CREATE INDEX "VerificationIntervention_chauffeurVerificationId_idx"
ON "VerificationIntervention"("chauffeurVerificationId");
CREATE INDEX "VerificationIntervention_accountVerificationId_idx"
ON "VerificationIntervention"("accountVerificationId");
CREATE INDEX "VerificationIntervention_documentApprovalId_idx"
ON "VerificationIntervention"("documentApprovalId");

ALTER TABLE "VerificationIntervention"
ADD CONSTRAINT "VerificationIntervention_chauffeurVerificationId_fkey"
FOREIGN KEY ("chauffeurVerificationId") REFERENCES "ChauffeurVerification"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationIntervention"
ADD CONSTRAINT "VerificationIntervention_accountVerificationId_fkey"
FOREIGN KEY ("accountVerificationId") REFERENCES "FleetOwnerAccountVerification"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationIntervention"
ADD CONSTRAINT "VerificationIntervention_documentApprovalId_fkey"
FOREIGN KEY ("documentApprovalId") REFERENCES "DocumentApproval"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VerificationIntervention"
ADD CONSTRAINT "VerificationIntervention_resolvedById_fkey"
FOREIGN KEY ("resolvedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VerificationIntervention"
ADD CONSTRAINT "VerificationIntervention_single_resource_check"
CHECK (
  ("chauffeurVerificationId" IS NOT NULL AND "accountVerificationId" IS NULL)
  OR
  ("chauffeurVerificationId" IS NULL AND "accountVerificationId" IS NOT NULL)
);
