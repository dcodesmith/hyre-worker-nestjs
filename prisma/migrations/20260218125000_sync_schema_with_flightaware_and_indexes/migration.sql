-- DropIndex
DROP INDEX "PayoutTransaction_bookingId_key";

-- AlterTable
ALTER TABLE "Car" ALTER COLUMN "airportPickupRate" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Flight_flightNumber_flightDate_idx" ON "Flight"("flightNumber", "flightDate");

-- CreateIndex
CREATE INDEX "Flight_alertId_idx" ON "Flight"("alertId");

-- CreateIndex
CREATE UNIQUE INDEX "FlightStatusEvent_flightId_eventType_eventTime_key" ON "FlightStatusEvent"("flightId", "eventType", "eventTime");

-- CreateIndex
CREATE INDEX "PayoutTransaction_bookingId_idx" ON "PayoutTransaction"("bookingId");

-- CreateIndex
CREATE INDEX "session_token_idx" ON "session"("token");
