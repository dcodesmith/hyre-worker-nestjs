CREATE TYPE "ExtensionCreationIdempotencyState" AS ENUM ('PROCESSING', 'COMPLETED');

ALTER TABLE "Extension"
ADD COLUMN "paymentSessionExpiresAt" TIMESTAMP(3);

CREATE INDEX "Extension_status_paymentStatus_paymentSessionExpiresAt_idx"
ON "Extension"("status", "paymentStatus", "paymentSessionExpiresAt");

CREATE TABLE "ExtensionCreationIdempotency" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "customerScope" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "resolvedBookingLegId" TEXT NOT NULL,
  "state" "ExtensionCreationIdempotencyState" NOT NULL DEFAULT 'PROCESSING',
  "extensionId" TEXT,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExtensionCreationIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExtensionCreationIdempotency_extensionId_key"
ON "ExtensionCreationIdempotency"("extensionId");

CREATE UNIQUE INDEX "ExtensionCreationIdempotency_customerScope_idempotencyKey_key"
ON "ExtensionCreationIdempotency"("customerScope", "idempotencyKey");

CREATE INDEX "ExtensionCreationIdempotency_state_updatedAt_idx"
ON "ExtensionCreationIdempotency"("state", "updatedAt");

ALTER TABLE "ExtensionCreationIdempotency"
ADD CONSTRAINT "ExtensionCreationIdempotency_extensionId_fkey"
FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;
