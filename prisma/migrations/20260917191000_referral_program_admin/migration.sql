-- Replace untyped key/value settings with one explicit, fail-closed programme.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "ReferralProgramConfig") THEN
        RAISE EXCEPTION 'ReferralProgramConfig must be empty before this migration; recreate reviewed values through the typed admin API';
    END IF;
END $$;

DROP TABLE "ReferralProgramConfig";

ALTER TABLE "ReferralReward" DROP COLUMN "releaseCondition";
DROP TYPE "ReferralReleaseCondition";
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "ReferralReward"
        GROUP BY "bookingId"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate referral rewards must be reconciled before enforcing one reward per booking';
    END IF;
END $$;

DROP INDEX "ReferralReward_bookingId_idx";
CREATE UNIQUE INDEX "ReferralReward_bookingId_key" ON "ReferralReward"("bookingId");

CREATE TYPE "ReferralProgramStatus" AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE "ReferralIncentiveType" AS ENUM ('FIXED', 'PERCENTAGE');
CREATE TYPE "ReferralProgramAuditAction" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED');

CREATE TABLE "ReferralProgram" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "status" "ReferralProgramStatus" NOT NULL DEFAULT 'ACTIVE',
    "refereeDiscountType" "ReferralIncentiveType" NOT NULL,
    "refereeDiscountValue" DECIMAL(10,2) NOT NULL,
    "refereeDiscountMaxAmount" DECIMAL(10,2),
    "referrerRewardType" "ReferralIncentiveType" NOT NULL,
    "referrerRewardValue" DECIMAL(10,2) NOT NULL,
    "referrerRewardMaxAmount" DECIMAL(10,2),
    "minimumBookingAmount" DECIMAL(10,2) NOT NULL,
    "eligibleBookingTypes" "BookingType"[] NOT NULL,
    "referralValidityDays" INTEGER NOT NULL,
    "maxCreditsPerBookingAmount" DECIMAL(10,2) NOT NULL,
    "maxCreditsPerBookingPercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,

    CONSTRAINT "ReferralProgram_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReferralProgram_singleton_check" CHECK ("id" = 'default'),
    CONSTRAINT "ReferralProgram_referee_value_check" CHECK ("refereeDiscountValue" > 0),
    CONSTRAINT "ReferralProgram_referee_percentage_check" CHECK (
        "refereeDiscountType" = 'FIXED'
        OR (
            "refereeDiscountValue" <= 100
            AND "refereeDiscountMaxAmount" IS NOT NULL
            AND "refereeDiscountMaxAmount" > 0
        )
    ),
    CONSTRAINT "ReferralProgram_referrer_value_check" CHECK ("referrerRewardValue" > 0),
    CONSTRAINT "ReferralProgram_referrer_percentage_check" CHECK (
        "referrerRewardType" = 'FIXED'
        OR (
            "referrerRewardValue" <= 100
            AND "referrerRewardMaxAmount" IS NOT NULL
            AND "referrerRewardMaxAmount" > 0
        )
    ),
    CONSTRAINT "ReferralProgram_minimum_booking_check" CHECK ("minimumBookingAmount" > 0),
    CONSTRAINT "ReferralProgram_eligible_types_check" CHECK (
        cardinality("eligibleBookingTypes") > 0
    ),
    CONSTRAINT "ReferralProgram_validity_days_check" CHECK ("referralValidityDays" >= 0),
    CONSTRAINT "ReferralProgram_credit_amount_check" CHECK ("maxCreditsPerBookingAmount" >= 0),
    CONSTRAINT "ReferralProgram_credit_percent_check" CHECK (
        "maxCreditsPerBookingPercent" >= 0
        AND "maxCreditsPerBookingPercent" <= 100
    )
);

CREATE TABLE "ReferralProgramAudit" (
    "id" UUID NOT NULL,
    "action" "ReferralProgramAuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralProgramAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReferralProgramAudit_createdAt_idx"
ON "ReferralProgramAudit"("createdAt" DESC);
