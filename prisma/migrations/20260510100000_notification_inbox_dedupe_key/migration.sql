-- AlterTable
ALTER TABLE "NotificationInbox" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "NotificationInbox_dedupeKey_key" ON "NotificationInbox"("dedupeKey");
