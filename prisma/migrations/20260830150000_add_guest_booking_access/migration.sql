ALTER TABLE "Booking"
ADD COLUMN "guestAccessTokenHash" TEXT,
ADD COLUMN "guestAccessTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Booking_guestAccessTokenHash_key"
ON "Booking"("guestAccessTokenHash");
