-- CreateEnum
CREATE TYPE "NotificationInboxType" AS ENUM ('CHAUFFEUR_ASSIGNED');

-- CreateEnum
CREATE TYPE "NotificationOutboxEventType" AS ENUM ('CHAUFFEUR_ASSIGNED');

-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DISPATCHED', 'FAILED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "NotificationInbox" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationInboxType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutboxEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "eventType" "NotificationOutboxEventType" NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationInbox_userId_readAt_idx" ON "NotificationInbox"("userId", "readAt");

-- CreateIndex
CREATE INDEX "NotificationInbox_createdAt_idx" ON "NotificationInbox"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutboxEvent_dedupeKey_key" ON "NotificationOutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutboxEvent_status_nextAttemptAt_idx" ON "NotificationOutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationOutboxEvent_bookingId_idx" ON "NotificationOutboxEvent"("bookingId");

-- CreateIndex
CREATE INDEX "NotificationOutboxEvent_userId_idx" ON "NotificationOutboxEvent"("userId");

-- AddForeignKey
ALTER TABLE "NotificationInbox" ADD CONSTRAINT "NotificationInbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutboxEvent" ADD CONSTRAINT "NotificationOutboxEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
