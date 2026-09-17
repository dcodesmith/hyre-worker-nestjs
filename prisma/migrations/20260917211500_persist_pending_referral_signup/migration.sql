CREATE TABLE "PendingReferralSignup" (
    "email" TEXT NOT NULL,
    "referrerUserId" UUID NOT NULL,
    "referralCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingReferralSignup_pkey" PRIMARY KEY ("email")
);

CREATE INDEX "PendingReferralSignup_expiresAt_idx"
ON "PendingReferralSignup"("expiresAt");

CREATE INDEX "PendingReferralSignup_referrerUserId_idx"
ON "PendingReferralSignup"("referrerUserId");

ALTER TABLE "PendingReferralSignup"
ADD CONSTRAINT "PendingReferralSignup_referrerUserId_fkey"
FOREIGN KEY ("referrerUserId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
