CREATE TYPE "BookingCreationIdempotencyState" AS ENUM ('PROCESSING', 'COMPLETED');

CREATE TABLE "BookingCreationIdempotency" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "customerScope" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "state" "BookingCreationIdempotencyState" NOT NULL DEFAULT 'PROCESSING',
  "bookingId" TEXT,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookingCreationIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingCreationIdempotency_bookingId_key"
ON "BookingCreationIdempotency"("bookingId");

CREATE UNIQUE INDEX "BookingCreationIdempotency_customerScope_idempotencyKey_key"
ON "BookingCreationIdempotency"("customerScope", "idempotencyKey");

CREATE INDEX "BookingCreationIdempotency_state_createdAt_idx"
ON "BookingCreationIdempotency"("state", "createdAt");

ALTER TABLE "BookingCreationIdempotency"
ADD CONSTRAINT "BookingCreationIdempotency_bookingId_fkey"
FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
