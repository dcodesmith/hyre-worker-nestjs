-- CreateEnum
CREATE TYPE "DomainOutboxEventType" AS ENUM (
  'REFERRAL_COMPLETION',
  'PAYOUT_PROCESSING'
);

-- CreateEnum
CREATE TYPE "DomainOutboxStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'DISPATCHED',
  'FAILED',
  'DEAD_LETTER'
);

-- CreateTable
CREATE TABLE "DomainOutboxEvent" (
  "id" TEXT NOT NULL,
  "eventType" "DomainOutboxEventType" NOT NULL,
  "status" "DomainOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "aggregateId" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DomainOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainOutboxEvent_dedupeKey_key"
ON "DomainOutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "DomainOutbox_status_retry_created_idx"
ON "DomainOutboxEvent"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "DomainOutbox_status_updated_idx"
ON "DomainOutboxEvent"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "DomainOutboxEvent_aggregateId_idx"
ON "DomainOutboxEvent"("aggregateId");
