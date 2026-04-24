-- AddCheckConstraint: discount value must be non-negative
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_discount_nonnegative"
  CHECK ("discountValue" >= 0);

-- AddCheckConstraint: percentage discounts cannot exceed 100
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_percentage_max100"
  CHECK ("discountType" != 'PERCENTAGE' OR "discountValue" <= 100);

-- AddCheckConstraint: end date must be after start date
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_dates_valid"
  CHECK ("endDate" > "startDate");
