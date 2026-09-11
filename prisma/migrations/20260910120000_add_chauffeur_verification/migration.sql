CREATE TYPE "ChauffeurVerificationStatus" AS ENUM (
  'INVITED',
  'CONSENTED',
  'PHONE_VERIFIED',
  'IDENTITY_VERIFIED',
  'APPROVED'
);

CREATE TYPE "ChauffeurVerificationStage" AS ENUM ('IDENTITY', 'DRIVING');

ALTER TYPE "DocumentType" ADD VALUE 'LASRRA';
ALTER TYPE "DocumentType" ADD VALUE 'DRIVER_BADGE';

ALTER TABLE "User" ADD COLUMN "chauffeurDisabledAt" TIMESTAMP(3);

CREATE TABLE "ChauffeurVerification" (
  "id" TEXT NOT NULL,
  "fleetOwnerId" TEXT NOT NULL,
  "chauffeurId" TEXT,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "invitationIdempotencyKey" TEXT NOT NULL,
  "invitationRequestHash" TEXT NOT NULL,
  "inviteTokenHash" TEXT NOT NULL,
  "inviteExpiresAt" TIMESTAMP(3) NOT NULL,
  "inviteAcceptedAt" TIMESTAMP(3),
  "sessionTokenHash" TEXT,
  "sessionExpiresAt" TIMESTAMP(3),
  "termsAcceptedAt" TIMESTAMP(3),
  "privacyAcceptedAt" TIMESTAMP(3),
  "phoneVerifiedAt" TIMESTAMP(3),
  "ninHash" TEXT,
  "ninLast4" TEXT,
  "identityFirstName" TEXT,
  "identityMiddleName" TEXT,
  "identityLastName" TEXT,
  "identityProviderRef" TEXT,
  "driversLicenseHash" TEXT,
  "driversLicenseLast4" TEXT,
  "driversLicenseExpiresAt" TIMESTAMP(3),
  "driversLicenseProviderRef" TEXT,
  "dateOfBirth" TIMESTAMP(3),
  "livenessProviderRef" TEXT,
  "livenessConfidence" DOUBLE PRECISION,
  "faceMatchConfidence" DOUBLE PRECISION,
  "selfieObjectKey" TEXT,
  "status" "ChauffeurVerificationStatus" NOT NULL DEFAULT 'INVITED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChauffeurVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChauffeurVerification_fleetOwnerId_fkey"
    FOREIGN KEY ("fleetOwnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChauffeurVerification_chauffeurId_fkey"
    FOREIGN KEY ("chauffeurId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ChauffeurVerificationStageRequest" (
  "id" TEXT NOT NULL,
  "verificationId" TEXT NOT NULL,
  "stage" "ChauffeurVerificationStage" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
  "failureReason" TEXT,
  "processingExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChauffeurVerificationStageRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChauffeurVerificationStageRequest_verificationId_fkey"
    FOREIGN KEY ("verificationId")
    REFERENCES "ChauffeurVerification"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChauffeurVerification_chauffeurId_key"
  ON "ChauffeurVerification"("chauffeurId");
CREATE UNIQUE INDEX "ChauffeurVerification_inviteTokenHash_key"
  ON "ChauffeurVerification"("inviteTokenHash");
CREATE UNIQUE INDEX "ChauffeurVerification_sessionTokenHash_key"
  ON "ChauffeurVerification"("sessionTokenHash");
CREATE UNIQUE INDEX "ChauffeurVerification_owner_invitation_idempotency_key"
  ON "ChauffeurVerification"("fleetOwnerId", "invitationIdempotencyKey");
CREATE UNIQUE INDEX "ChauffeurVerification_fleetOwnerId_email_key"
  ON "ChauffeurVerification"("fleetOwnerId", "email");
CREATE UNIQUE INDEX "ChauffeurVerification_approved_ninHash_key"
  ON "ChauffeurVerification"("ninHash")
  WHERE "ninHash" IS NOT NULL
    AND "status" = 'APPROVED'::"ChauffeurVerificationStatus";
CREATE UNIQUE INDEX "ChauffeurVerification_approved_driversLicenseHash_key"
  ON "ChauffeurVerification"("driversLicenseHash")
  WHERE "driversLicenseHash" IS NOT NULL
    AND "status" = 'APPROVED'::"ChauffeurVerificationStatus";
CREATE INDEX "ChauffeurVerification_fleetOwnerId_status_createdAt_idx"
  ON "ChauffeurVerification"("fleetOwnerId", "status", "createdAt");

CREATE UNIQUE INDEX "ChauffeurStageRequest_verification_idempotency_key"
  ON "ChauffeurVerificationStageRequest"("verificationId", "idempotencyKey");
CREATE UNIQUE INDEX "ChauffeurStageRequest_one_processing_per_stage_idx"
  ON "ChauffeurVerificationStageRequest"("verificationId", "stage")
  WHERE "status" = 'PROCESSING';
CREATE INDEX "ChauffeurVerificationStageRequest_verificationId_stage_createdAt_idx"
  ON "ChauffeurVerificationStageRequest"("verificationId", "stage", "createdAt");

CREATE INDEX "User_chauffeurDisabledAt_idx" ON "User"("chauffeurDisabledAt");

ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_chauffeur_active_window_excl"
EXCLUDE USING gist (
  "chauffeurId" WITH =,
  tsrange(
    "startDate",
    "endDate" + INTERVAL '2 hours',
    '[)'
  ) WITH &&
)
WHERE (
  "chauffeurId" IS NOT NULL
  AND "deletedAt" IS NULL
  AND "status" IN (
    'PENDING'::"BookingStatus",
    'CONFIRMED'::"BookingStatus",
    'ACTIVE'::"BookingStatus"
  )
);
