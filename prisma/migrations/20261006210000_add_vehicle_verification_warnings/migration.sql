ALTER TABLE "VehicleVerification"
ADD COLUMN "providerWarnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
