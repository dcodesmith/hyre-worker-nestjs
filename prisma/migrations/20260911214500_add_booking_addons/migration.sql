-- Clean pre-launch cutover: the legacy security-detail rate and booking column
-- have no production data to preserve.
DROP TABLE "AddonRate";
DROP TYPE "AddonType";
ALTER TABLE "Booking" DROP COLUMN "securityDetailCost";

CREATE TYPE "AddonPricingUnit" AS ENUM ('PER_BOOKING', 'PER_LEG');
CREATE TYPE "AddonFinancialTreatment" AS ENUM ('PLATFORM', 'FLEET_OWNER');

CREATE TABLE "Addon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "bookingTypes" "BookingType"[] NOT NULL,
    "pricingUnit" "AddonPricingUnit" NOT NULL,
    "financialTreatment" "AddonFinancialTreatment" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AddonPrice" (
    "id" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "effectiveSince" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddonPrice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookingAddon" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricingUnit" "AddonPricingUnit" NOT NULL,
    "financialTreatment" "AddonFinancialTreatment" NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAddon_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Addon_code_key" ON "Addon"("code");
CREATE INDEX "Addon_isActive_idx" ON "Addon"("isActive");
CREATE UNIQUE INDEX "AddonPrice_addonId_effectiveSince_key" ON "AddonPrice"("addonId", "effectiveSince");
CREATE INDEX "AddonPrice_addonId_effectiveSince_effectiveUntil_idx" ON "AddonPrice"("addonId", "effectiveSince", "effectiveUntil");
CREATE UNIQUE INDEX "BookingAddon_bookingId_addonId_key" ON "BookingAddon"("bookingId", "addonId");
CREATE INDEX "BookingAddon_addonId_idx" ON "BookingAddon"("addonId");

ALTER TABLE "Addon" ADD CONSTRAINT "Addon_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AddonPrice" ADD CONSTRAINT "AddonPrice_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AddonPrice" ADD CONSTRAINT "AddonPrice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AddonPrice" ADD CONSTRAINT "AddonPrice_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingAddon" ADD CONSTRAINT "BookingAddon_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookingAddon" ADD CONSTRAINT "BookingAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
