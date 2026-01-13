-- AlterTable
ALTER TABLE "Car" ALTER COLUMN "fuelUpgradeRate" DROP NOT NULL;

-- AddTable
ALTER TABLE "Car" ADD COLUMN "pricingIncludesFuel" BOOLEAN NOT NULL DEFAULT false;

-- The Booking-Review relation name is already explicit in the schema
-- This migration documents the schema change where fuelUpgradeRate was made optional
-- and adds the pricingIncludesFuel column