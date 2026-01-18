-- AlterTable
ALTER TABLE "Car" ALTER COLUMN "fuelUpgradeRate" DROP NOT NULL;

-- Add Booking columns that exist in the schema but were missing from migrations
ALTER TABLE "Booking" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "flightNumber" TEXT;
ALTER TABLE "Booking" ADD COLUMN "estimatedDuration" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "flightId" TEXT;

-- AddTable
ALTER TABLE "Car" ADD COLUMN "pricingIncludesFuel" BOOLEAN NOT NULL DEFAULT false;

-- The Booking-Review relation name is already explicit in the schema
-- This migration documents the schema change where fuelUpgradeRate was made optional,
-- adds the pricingIncludesFuel column, and includes Booking.deletedAt for soft deletes.