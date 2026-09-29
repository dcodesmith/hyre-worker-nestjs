ALTER TYPE "VerificationInterventionKind" ADD VALUE 'OWNER_DRIVER_FACE';
ALTER TYPE "VerificationInterventionStatus" ADD VALUE 'RETAKE_REQUESTED';

ALTER TABLE "ChauffeurVerification"
ADD COLUMN "selfieRetakeRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "FleetOwnerAccountVerification"
ADD COLUMN "identityOfficialPhoto" TEXT,
ADD COLUMN "selfieObjectKey" TEXT,
ADD COLUMN "selfieRetakeRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "faceDecision" "VerificationDecisionStatus" NOT NULL DEFAULT 'PENDING';
