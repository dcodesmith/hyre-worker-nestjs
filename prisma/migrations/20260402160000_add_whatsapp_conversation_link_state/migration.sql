-- Add explicit link state for secure WhatsApp-to-user association.
CREATE TYPE "WhatsAppLinkStatus" AS ENUM (
  'UNLINKED',
  'PENDING_VERIFICATION',
  'LINKED',
  'REVOKED'
);

ALTER TABLE "WhatsAppConversation"
ADD COLUMN "linkedUserId" TEXT,
ADD COLUMN "linkStatus" "WhatsAppLinkStatus" NOT NULL DEFAULT 'UNLINKED',
ADD COLUMN "linkRequestedAt" TIMESTAMP(3),
ADD COLUMN "linkVerifiedAt" TIMESTAMP(3);

ALTER TABLE "WhatsAppConversation"
ADD CONSTRAINT "WhatsAppConversation_linkedUserId_fkey"
FOREIGN KEY ("linkedUserId") REFERENCES "User"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

CREATE INDEX "WhatsAppConversation_linkedUserId_idx"
ON "WhatsAppConversation"("linkedUserId");

CREATE INDEX "WhatsAppConversation_linkStatus_idx"
ON "WhatsAppConversation"("linkStatus");
