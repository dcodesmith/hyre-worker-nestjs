-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('SEDAN', 'SUV', 'LUXURY_SEDAN', 'LUXURY_SUV', 'VAN', 'CROSSOVER');

-- CreateEnum
CREATE TYPE "ServiceTier" AS ENUM ('STANDARD', 'EXECUTIVE', 'LUXURY', 'ULTRA_LUXURY');

-- CreateEnum
CREATE TYPE "FlightStatus" AS ENUM ('SCHEDULED', 'DEPARTED', 'EN_ROUTE', 'LANDED', 'CANCELLED', 'DIVERTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FlightDataSource" AS ENUM ('FLIGHTAWARE', 'MANUAL', 'CACHED');

-- AlterEnum (add AIRPORT_PICKUP to BookingType)
ALTER TYPE "BookingType" ADD VALUE 'AIRPORT_PICKUP';

-- AlterEnum (add LASDRI to DocumentType)
ALTER TYPE "DocumentType" ADD VALUE 'LASDRI';

-- AlterEnum (add REFUND_ERROR to PaymentAttemptStatus)
ALTER TYPE "PaymentAttemptStatus" ADD VALUE 'REFUND_ERROR';

-- AlterTable Car (add missing columns)
ALTER TABLE "Car" ADD COLUMN "airportPickupRate" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Car" ADD COLUMN "vehicleType" "VehicleType" NOT NULL DEFAULT 'SEDAN';
ALTER TABLE "Car" ADD COLUMN "serviceTier" "ServiceTier" NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "Car" ADD COLUMN "passengerCapacity" INTEGER NOT NULL DEFAULT 4;

-- AlterTable User (add missing columns)
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "image" TEXT;
ALTER TABLE "User" ADD COLUMN "isOwnerDriver" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable Flight
CREATE TABLE "Flight" (
    "id" TEXT NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "flightDate" DATE NOT NULL,
    "faFlightId" TEXT,
    "originCode" TEXT NOT NULL,
    "originCodeIATA" TEXT,
    "originName" TEXT,
    "originCity" TEXT,
    "destinationCode" TEXT NOT NULL,
    "destinationCodeIATA" TEXT,
    "destinationName" TEXT,
    "destinationCity" TEXT,
    "scheduledDeparture" TIMESTAMP(3),
    "scheduledArrival" TIMESTAMP(3) NOT NULL,
    "estimatedDeparture" TIMESTAMP(3),
    "estimatedArrival" TIMESTAMP(3),
    "actualDeparture" TIMESTAMP(3),
    "actualArrival" TIMESTAMP(3),
    "status" "FlightStatus" NOT NULL DEFAULT 'SCHEDULED',
    "delayMinutes" INTEGER,
    "aircraftType" TEXT,
    "registration" TEXT,
    "departureGate" TEXT,
    "arrivalGate" TEXT,
    "alertId" TEXT,
    "alertEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertCreatedAt" TIMESTAMP(3),
    "alertDisabledAt" TIMESTAMP(3),
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataSource" "FlightDataSource" NOT NULL DEFAULT 'FLIGHTAWARE',
    "isLive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Flight_pkey" PRIMARY KEY ("id")
);

-- CreateTable FlightStatusEvent
CREATE TABLE "FlightStatusEvent" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "eventData" JSONB NOT NULL,
    "oldStatus" "FlightStatus",
    "newStatus" "FlightStatus",
    "delayChange" INTEGER,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "notificationsSent" BOOLEAN NOT NULL DEFAULT false,
    "notifiedUserIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlightStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable Review
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "overallRating" INTEGER NOT NULL,
    "carRating" INTEGER NOT NULL,
    "chauffeurRating" INTEGER NOT NULL,
    "serviceRating" INTEGER NOT NULL,
    "comment" TEXT,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "moderatedAt" TIMESTAMP(3),
    "moderatedBy" TEXT,
    "moderationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable Session (better-auth)
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable Verification (better-auth)
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable RateLimit (better-auth)
CREATE TABLE "rateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex Flight
CREATE UNIQUE INDEX "Flight_alertId_key" ON "Flight"("alertId");
CREATE UNIQUE INDEX "Flight_flightNumber_flightDate_key" ON "Flight"("flightNumber", "flightDate");
CREATE INDEX "Flight_flightNumber_flightDate_idx" ON "Flight"("flightNumber", "flightDate");
CREATE INDEX "Flight_status_idx" ON "Flight"("status");
CREATE INDEX "Flight_alertId_idx" ON "Flight"("alertId");
CREATE INDEX "Flight_destinationCodeIATA_flightDate_idx" ON "Flight"("destinationCodeIATA", "flightDate");
CREATE INDEX "Flight_scheduledArrival_idx" ON "Flight"("scheduledArrival");

-- CreateIndex FlightStatusEvent
CREATE INDEX "FlightStatusEvent_flightId_eventTime_idx" ON "FlightStatusEvent"("flightId", "eventTime");
CREATE INDEX "FlightStatusEvent_eventType_idx" ON "FlightStatusEvent"("eventType");
CREATE INDEX "FlightStatusEvent_processed_idx" ON "FlightStatusEvent"("processed");

-- CreateIndex Review
CREATE UNIQUE INDEX "Review_bookingId_key" ON "Review"("bookingId");
CREATE INDEX "Review_userId_idx" ON "Review"("userId");
CREATE INDEX "Review_overallRating_idx" ON "Review"("overallRating");
CREATE INDEX "Review_carRating_idx" ON "Review"("carRating");
CREATE INDEX "Review_chauffeurRating_idx" ON "Review"("chauffeurRating");
CREATE INDEX "Review_serviceRating_idx" ON "Review"("serviceRating");
CREATE INDEX "Review_isVisible_idx" ON "Review"("isVisible");
CREATE INDEX "Review_createdAt_idx" ON "Review"("createdAt");
CREATE INDEX "Review_moderatedBy_idx" ON "Review"("moderatedBy");

-- CreateIndex Car (new columns)
CREATE INDEX "Car_vehicleType_idx" ON "Car"("vehicleType");
CREATE INDEX "Car_serviceTier_idx" ON "Car"("serviceTier");
CREATE INDEX "Car_serviceTier_vehicleType_idx" ON "Car"("serviceTier", "vehicleType");

-- CreateIndex Session
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");
CREATE INDEX "session_userId_idx" ON "session"("userId");
CREATE INDEX "session_token_idx" ON "session"("token");

-- CreateIndex Verification
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");
CREATE INDEX "verification_value_idx" ON "verification"("value");

-- CreateIndex RateLimit
CREATE UNIQUE INDEX "rateLimit_key_key" ON "rateLimit"("key");

-- CreateIndex Booking (flightId)
CREATE INDEX "Booking_flightId_idx" ON "Booking"("flightId");
CREATE INDEX "Booking_deletedAt_idx" ON "Booking"("deletedAt");

-- CreateIndex Payment (refundIdempotencyKey)
ALTER TABLE "Payment" ADD COLUMN "refundIdempotencyKey" TEXT;
CREATE UNIQUE INDEX "Payment_refundIdempotencyKey_key" ON "Payment"("refundIdempotencyKey");

-- AddForeignKey Flight
ALTER TABLE "FlightStatusEvent" ADD CONSTRAINT "FlightStatusEvent_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey Booking to Flight
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey Review
ALTER TABLE "Review" ADD CONSTRAINT "Review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_moderatedBy_fkey" FOREIGN KEY ("moderatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey Session
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
