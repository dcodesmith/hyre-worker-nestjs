-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS', 'ANDROID');

-- CreateTable
CREATE TABLE "UserPushToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPushToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPushToken_token_key" ON "UserPushToken"("token");

-- CreateIndex
CREATE INDEX "UserPushToken_userId_revokedAt_idx" ON "UserPushToken"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserPushToken_revokedAt_idx" ON "UserPushToken"("revokedAt");

-- AddForeignKey
ALTER TABLE "UserPushToken" ADD CONSTRAINT "UserPushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
