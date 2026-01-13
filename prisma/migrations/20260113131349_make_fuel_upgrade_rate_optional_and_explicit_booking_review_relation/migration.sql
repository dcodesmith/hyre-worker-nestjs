-- AlterTable
ALTER TABLE "Car" ALTER COLUMN "fuelUpgradeRate" DROP NOT NULL;

-- The Booking-Review relation name is already explicit in the schema
-- This migration documents the schema change where fuelUpgradeRate was made optional
