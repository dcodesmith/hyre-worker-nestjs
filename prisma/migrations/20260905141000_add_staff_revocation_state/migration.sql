-- AlterTable
ALTER TABLE "User" ADD COLUMN "staffRevokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_staffRevokedAt_idx" ON "User"("staffRevokedAt");
