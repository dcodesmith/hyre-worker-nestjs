-- AlterTable
ALTER TABLE "VehicleVerification"
ADD COLUMN "insurancePolicyNumber" TEXT,
ADD COLUMN "insurancePolicyStatus" TEXT,
ADD COLUMN "insurancePolicyExpiresAt" TIMESTAMP(3),
ADD COLUMN "insuranceProviderRef" TEXT;
