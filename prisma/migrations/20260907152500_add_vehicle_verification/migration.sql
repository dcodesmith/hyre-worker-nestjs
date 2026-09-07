-- CreateEnum
CREATE TYPE "ProviderVerificationStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Car"
ADD COLUMN "chassisNumber" TEXT,
ADD COLUMN "submittedAt" TIMESTAMP(3),
ALTER COLUMN "hourlyRate" DROP NOT NULL,
ALTER COLUMN "dayRate" DROP NOT NULL,
ALTER COLUMN "nightRate" DROP NOT NULL,
ALTER COLUMN "fullDayRate" DROP NOT NULL,
ALTER COLUMN "airportPickupRate" DROP NOT NULL;

-- Existing cars predate draft onboarding and are already submitted.
UPDATE "Car" SET "submittedAt" = "createdAt" WHERE "submittedAt" IS NULL;

-- CreateTable
CREATE TABLE "VehicleVerification" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "chassisNumber" TEXT,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "passengerCapacity" INTEGER,
    "plateProviderRef" TEXT,
    "vinProviderRef" TEXT,
    "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "carId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceVerification" (
    "id" TEXT NOT NULL,
    "carId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "policyStatus" TEXT,
    "policyExpiresAt" TIMESTAMP(3),
    "providerRef" TEXT,
    "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceVerification_pkey" PRIMARY KEY ("id")
);

-- Fail before changing data if legacy formatting hides duplicate physical plates.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Car"
        GROUP BY regexp_replace(upper("registrationNumber"), '[^A-Z0-9]', '', 'g')
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate canonical car registration numbers must be resolved before this migration';
    END IF;
END $$;

-- Normalize legacy values before enforcing the canonical registration format.
UPDATE "Car"
SET "registrationNumber" = regexp_replace(upper("registrationNumber"), '[^A-Z0-9]', '', 'g');

-- CreateIndex
CREATE UNIQUE INDEX "Car_registrationNumber_key" ON "Car"("registrationNumber");
CREATE UNIQUE INDEX "Car_chassisNumber_key" ON "Car"("chassisNumber");
CREATE UNIQUE INDEX "VehicleVerification_carId_key" ON "VehicleVerification"("carId");
CREATE UNIQUE INDEX "VehicleVerification_ownerId_idempotencyKey_key" ON "VehicleVerification"("ownerId", "idempotencyKey");
CREATE INDEX "VehicleVerification_ownerId_plateNumber_idx" ON "VehicleVerification"("ownerId", "plateNumber");
CREATE INDEX "VehicleVerification_status_createdAt_idx" ON "VehicleVerification"("status", "createdAt");
CREATE UNIQUE INDEX "InsuranceVerification_ownerId_idempotencyKey_key" ON "InsuranceVerification"("ownerId", "idempotencyKey");
CREATE INDEX "InsuranceVerification_carId_status_createdAt_idx" ON "InsuranceVerification"("carId", "status", "createdAt");

-- AddCheckConstraint
ALTER TABLE "Car" ADD CONSTRAINT "Car_approved_pricing_check" CHECK (
    "approvalStatus" <> 'APPROVED'
    OR (
        "hourlyRate" > 0
        AND "dayRate" > 0
        AND "nightRate" > 0
        AND "fullDayRate" > 0
        AND "airportPickupRate" > 0
        AND ("pricingIncludesFuel" OR COALESCE("fuelUpgradeRate" > 0, false))
    )
);

-- AddForeignKey
ALTER TABLE "VehicleVerification" ADD CONSTRAINT "VehicleVerification_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleVerification" ADD CONSTRAINT "VehicleVerification_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InsuranceVerification" ADD CONSTRAINT "InsuranceVerification_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InsuranceVerification" ADD CONSTRAINT "InsuranceVerification_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
