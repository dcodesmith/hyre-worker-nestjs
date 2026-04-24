-- Deactivate any existing FIXED_AMOUNT promotions so they stop affecting bookings.
UPDATE "Promotion"
SET "isActive" = false
WHERE "discountType" = 'FIXED_AMOUNT';

-- Convert remaining FIXED_AMOUNT rows to PERCENTAGE so the data is
-- consistent before we drop the column. Cap the value at 50 to match
-- the new MAX_PROMOTION_PERCENTAGE business rule.
UPDATE "Promotion"
SET "discountType" = 'PERCENTAGE',
    "discountValue" = LEAST("discountValue", 50)
WHERE "discountType" = 'FIXED_AMOUNT';

-- Drop the column and enum entirely — all promotions are now
-- percentage-based, so the type field carries no information.
ALTER TABLE "Promotion" DROP COLUMN "discountType";
DROP TYPE "DiscountType";

-- Enforce valid percentage range at the database level.
ALTER TABLE "Promotion"
  ADD CONSTRAINT check_promotion_discount_value
  CHECK ("discountValue" BETWEEN 1 AND 50);
