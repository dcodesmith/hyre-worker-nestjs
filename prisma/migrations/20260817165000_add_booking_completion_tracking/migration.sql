-- CreateEnum
CREATE TYPE "BookingCompletionSource" AS ENUM ('SCHEDULED', 'CHAUFFEUR_LINK', 'FLEET_OWNER', 'OPERATIONS');

-- AlterTable
ALTER TABLE "Booking"
ADD COLUMN "completedAt" TIMESTAMP(3),
ADD COLUMN "completedByUserId" TEXT,
ADD COLUMN "completionSource" "BookingCompletionSource",
ADD COLUMN "completionTokenHash" TEXT,
ADD COLUMN "completionTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Booking_completedByUserId_idx" ON "Booking"("completedByUserId");

-- AddForeignKey
ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_completedByUserId_fkey"
FOREIGN KEY ("completedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
