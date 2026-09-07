-- Fail instead of inventing prices when legacy approved cars violate the invariant.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Car"
        WHERE "approvalStatus" = 'APPROVED'
          AND NOT (
              COALESCE("hourlyRate" > 0, false)
              AND COALESCE("dayRate" > 0, false)
              AND COALESCE("nightRate" > 0, false)
              AND COALESCE("fullDayRate" > 0, false)
              AND COALESCE("airportPickupRate" > 0, false)
              AND ("pricingIncludesFuel" OR COALESCE("fuelUpgradeRate" > 0, false))
          )
    ) THEN
        RAISE EXCEPTION 'Approved cars with incomplete pricing must be resolved before this migration';
    END IF;
END $$;

ALTER TABLE "Car" DROP CONSTRAINT "Car_approved_pricing_check";

ALTER TABLE "Car" ADD CONSTRAINT "Car_approved_pricing_check" CHECK (
    "approvalStatus" <> 'APPROVED'
    OR (
        COALESCE("hourlyRate" > 0, false)
        AND COALESCE("dayRate" > 0, false)
        AND COALESCE("nightRate" > 0, false)
        AND COALESCE("fullDayRate" > 0, false)
        AND COALESCE("airportPickupRate" > 0, false)
        AND ("pricingIncludesFuel" OR COALESCE("fuelUpgradeRate" > 0, false))
    )
) NOT VALID;
