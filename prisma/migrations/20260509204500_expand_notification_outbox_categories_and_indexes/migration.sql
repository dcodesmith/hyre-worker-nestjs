-- AlterEnum
ALTER TYPE "NotificationInboxType" ADD VALUE IF NOT EXISTS 'BOOKING_ASSIGNMENT';
ALTER TYPE "NotificationInboxType" ADD VALUE IF NOT EXISTS 'BOOKING_LIFECYCLE';
ALTER TYPE "NotificationInboxType" ADD VALUE IF NOT EXISTS 'BOOKING_REMINDER';

-- AlterEnum
ALTER TYPE "NotificationOutboxEventType" ADD VALUE IF NOT EXISTS 'BOOKING_ASSIGNMENT';
ALTER TYPE "NotificationOutboxEventType" ADD VALUE IF NOT EXISTS 'BOOKING_LIFECYCLE';
ALTER TYPE "NotificationOutboxEventType" ADD VALUE IF NOT EXISTS 'BOOKING_REMINDER';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Booking_status_paymentStatus_startDate_idx"
ON "Booking"("status", "paymentStatus", "startDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Booking_status_paymentStatus_endDate_idx"
ON "Booking"("status", "paymentStatus", "endDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookingLeg_legDate_legStartTime_idx"
ON "BookingLeg"("legDate", "legStartTime");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookingLeg_legDate_legEndTime_idx"
ON "BookingLeg"("legDate", "legEndTime");
