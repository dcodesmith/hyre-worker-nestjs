ALTER TABLE "FleetOwnerAccountVerification"
ADD COLUMN "driversLicenseHash" TEXT,
ADD COLUMN "driversLicenseLast4" TEXT,
ADD COLUMN "driversLicenseExpiresAt" TIMESTAMP(3),
ADD COLUMN "driversLicenseProviderRef" TEXT;
