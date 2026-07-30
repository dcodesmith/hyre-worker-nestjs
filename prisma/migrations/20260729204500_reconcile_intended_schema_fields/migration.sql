-- These objects are present in the Prisma schema but were never captured in
-- migration history. Guards keep this migration safe for development databases
-- where `prisma db push` may already have created some or all of them.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type_state
    JOIN pg_namespace namespace ON namespace.oid = type_state.typnamespace
    WHERE namespace.nspname = current_schema()
      AND type_state.typname = 'BookingAcquisitionChannel'
  ) THEN
    CREATE TYPE "BookingAcquisitionChannel" AS ENUM ('GLOBAL', 'PARTNER');
  END IF;
END $$;

ALTER TABLE "Booking"
ADD COLUMN IF NOT EXISTS "acquisitionChannel" "BookingAcquisitionChannel" NOT NULL DEFAULT 'GLOBAL',
ADD COLUMN IF NOT EXISTS "acquisitionPartnerOwnerId" TEXT,
ADD COLUMN IF NOT EXISTS "acquisitionPartnerSlug" TEXT;

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "privacyAcceptedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);

ALTER TABLE "VehicleImage"
ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Booking_acquisitionChannel_idx"
ON "Booking"("acquisitionChannel");

CREATE INDEX IF NOT EXISTS "Booking_acquisitionPartnerOwnerId_createdAt_idx"
ON "Booking"("acquisitionPartnerOwnerId", "createdAt");

CREATE INDEX IF NOT EXISTS "VehicleImage_carId_isPrimary_idx"
ON "VehicleImage"("carId", "isPrimary");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_state
    JOIN pg_class table_state ON table_state.oid = constraint_state.conrelid
    JOIN pg_namespace namespace ON namespace.oid = table_state.relnamespace
    WHERE namespace.nspname = current_schema()
      AND table_state.relname = 'Booking'
      AND constraint_state.conname = 'Booking_acquisitionPartnerOwnerId_fkey'
  ) THEN
    ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_acquisitionPartnerOwnerId_fkey"
    FOREIGN KEY ("acquisitionPartnerOwnerId")
    REFERENCES "User"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END $$;
