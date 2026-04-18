-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "carId" TEXT,
    "name" TEXT,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_ownerId_idx" ON "Promotion"("ownerId");

-- CreateIndex
CREATE INDEX "Promotion_carId_idx" ON "Promotion"("carId");

-- CreateIndex
CREATE INDEX "Promotion_isActive_startDate_endDate_idx" ON "Promotion"("isActive", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Promotion_ownerId_isActive_idx" ON "Promotion"("ownerId", "isActive");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint: end date must be after start date
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_dates_valid"
  CHECK ("endDate" > "startDate");

-- AddCheckConstraint: percentage discount must be between 1 and 50 inclusive
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_discount_value_range"
  CHECK ("discountValue" BETWEEN 1 AND 50);
