-- Align DB VehicleType enum with current Prisma schema (no legacy backfill).
-- This migration intentionally fails if legacy enum values still exist in data.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Car"
    WHERE "vehicleType"::text IN ('LUXURY_SEDAN', 'LUXURY_SUV')
  ) THEN
    RAISE EXCEPTION
      'Cannot align VehicleType enum: Car rows still contain LUXURY_SEDAN/LUXURY_SUV.';
  END IF;
END $$;

CREATE TYPE "VehicleType_new" AS ENUM ('SEDAN', 'SUV', 'VAN', 'CROSSOVER');

ALTER TABLE "Car"
ALTER COLUMN "vehicleType" TYPE "VehicleType_new"
USING ("vehicleType"::text::"VehicleType_new");

ALTER TABLE "Car"
ALTER COLUMN "vehicleType" SET DEFAULT 'SEDAN';

DROP TYPE "VehicleType";
ALTER TYPE "VehicleType_new" RENAME TO "VehicleType";
