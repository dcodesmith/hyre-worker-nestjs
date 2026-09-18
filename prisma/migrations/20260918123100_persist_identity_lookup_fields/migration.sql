ALTER TABLE "ChauffeurVerification"
ADD COLUMN "identityOfficialPhoto" TEXT;

ALTER TABLE "FleetOwnerAccountVerification"
ADD COLUMN "identityDateOfBirth" TIMESTAMP(3);
