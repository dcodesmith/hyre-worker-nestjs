ALTER TABLE "Booking"
ADD COLUMN "paymentReconciliationCheckedAt" TIMESTAMP(3);

ALTER TABLE "Extension"
ADD COLUMN "paymentReconciliationCheckedAt" TIMESTAMP(3);
