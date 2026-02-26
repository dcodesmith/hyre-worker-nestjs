-- CreateEnum
CREATE TYPE "WhatsAppConversationStatus" AS ENUM ('ACTIVE', 'HANDOFF', 'CLOSED');

-- CreateEnum
CREATE TYPE "BookingDraftStatus" AS ENUM ('NEW', 'COLLECTING', 'QUOTED', 'AWAITING_PAYMENT', 'CONFIRMED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WhatsAppMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "WhatsAppMessageKind" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'DOCUMENT', 'LOCATION', 'INTERACTIVE', 'SYSTEM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsAppOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "WhatsAppDeliveryMode" AS ENUM ('FREE_FORM', 'TEMPLATE');

-- AlterEnum
ALTER TYPE "PaymentAttemptStatus" ADD VALUE 'REFUND_ERROR';

-- DropIndex
DROP INDEX "Review_bookingId_idx";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "refundIdempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "marketingConsent",
DROP COLUMN "privacyAcceptedAt",
DROP COLUMN "termsAcceptedAt";

-- AlterTable
ALTER TABLE "_RoleToUser" ADD CONSTRAINT "_RoleToUser_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_RoleToUser_AB_unique";

-- CreateTable
CREATE TABLE "WhatsAppConversation" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "waId" TEXT,
    "profileName" TEXT,
    "status" "WhatsAppConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "windowExpiresAt" TIMESTAMP(3),
    "handoffReason" TEXT,
    "handoffAt" TIMESTAMP(3),
    "activeBookingDraftId" TEXT,
    "processingLockToken" TEXT,
    "processingLockExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "providerMessageSid" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "direction" "WhatsAppMessageDirection" NOT NULL,
    "kind" "WhatsAppMessageKind" NOT NULL DEFAULT 'UNKNOWN',
    "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "body" TEXT,
    "mediaUrl" TEXT,
    "mediaContentType" TEXT,
    "providerStatus" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rawPayload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppOutbox" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "mode" "WhatsAppDeliveryMode" NOT NULL,
    "status" "WhatsAppOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "textBody" TEXT,
    "mediaUrl" TEXT,
    "templateName" TEXT,
    "templateVariables" JSONB,
    "payload" JSONB,
    "providerMessageSid" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingDraft" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "BookingDraftStatus" NOT NULL DEFAULT 'NEW',
    "state" JSONB NOT NULL,
    "selectedOptionId" TEXT,
    "quoteExpiresAt" TIMESTAMP(3),
    "checkoutUrl" TEXT,
    "checkoutExpiresAt" TIMESTAMP(3),
    "linkedBookingId" TEXT,
    "paymentStatus" "PaymentStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_phoneE164_key" ON "WhatsAppConversation"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_waId_key" ON "WhatsAppConversation"("waId");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_status_idx" ON "WhatsAppConversation"("status");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_windowExpiresAt_idx" ON "WhatsAppConversation"("windowExpiresAt");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_processingLockExpiresAt_idx" ON "WhatsAppConversation"("processingLockExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_providerMessageSid_key" ON "WhatsAppMessage"("providerMessageSid");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_dedupeKey_key" ON "WhatsAppMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_conversationId_receivedAt_idx" ON "WhatsAppMessage"("conversationId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "WhatsAppMessage_direction_status_idx" ON "WhatsAppMessage"("direction", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppOutbox_dedupeKey_key" ON "WhatsAppOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "WhatsAppOutbox_conversationId_createdAt_idx" ON "WhatsAppOutbox"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WhatsAppOutbox_status_nextAttemptAt_idx" ON "WhatsAppOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "BookingDraft_conversationId_status_idx" ON "BookingDraft"("conversationId", "status");

-- CreateIndex
CREATE INDEX "BookingDraft_updatedAt_idx" ON "BookingDraft"("updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "FlightStatusEvent_flightId_eventType_eventTime_key" ON "FlightStatusEvent"("flightId", "eventType", "eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_refundIdempotencyKey_key" ON "Payment"("refundIdempotencyKey");

-- CreateIndex
CREATE INDEX "Review_serviceRating_idx" ON "Review"("serviceRating");

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppOutbox" ADD CONSTRAINT "WhatsAppOutbox_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingDraft" ADD CONSTRAINT "BookingDraft_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

