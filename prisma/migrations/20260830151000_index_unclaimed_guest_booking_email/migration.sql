CREATE INDEX "Booking_unclaimed_guest_email_idx"
ON "Booking" (LOWER("guestUser"->>'email'))
WHERE "userId" IS NULL AND "deletedAt" IS NULL;
