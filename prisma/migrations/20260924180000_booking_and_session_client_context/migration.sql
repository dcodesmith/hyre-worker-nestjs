ALTER TABLE "Booking" ADD COLUMN "ipAddress" TEXT,
ADD COLUMN "userAgent" TEXT,
ADD COLUMN "country" TEXT;

ALTER TABLE "session" ADD COLUMN "country" TEXT;
