-- CreateEnum
CREATE TYPE "Status" AS ENUM ('AVAILABLE', 'BOOKED', 'HOLD', 'IN_SERVICE');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'REFUNDED', 'REFUND_PROCESSING', 'REFUND_FAILED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "BookingType" AS ENUM ('DAY', 'NIGHT');

-- CreateEnum
CREATE TYPE "ExtensionEventType" AS ENUM ('HOURLY_ADDITION', 'NEW_DAY_ADDITION');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCESSFUL', 'FAILED', 'REFUNDED', 'REFUND_PROCESSING', 'REFUND_FAILED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "PayoutTransactionStatus" AS ENUM ('PENDING_APPROVAL', 'PENDING_DISBURSEMENT', 'PROCESSING', 'PAID_OUT', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CarApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FleetOwnerStatus" AS ENUM ('PROCESSING', 'APPROVED', 'ON_HOLD', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ChauffeurApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('NIN', 'DRIVERS_LICENSE', 'MOT_CERTIFICATE', 'INSURANCE_CERTIFICATE', 'VEHICLE_IMAGES', 'CERTIFICATE_OF_INCORPORATION');

-- CreateEnum
CREATE TYPE "PlatformFeeType" AS ENUM ('PLATFORM_SERVICE_FEE', 'FLEET_OWNER_COMMISSION');

-- CreateTable
CREATE TABLE "Car" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "dayRate" INTEGER NOT NULL,
    "nightRate" INTEGER NOT NULL,
    "hourlyRate" INTEGER NOT NULL,
    "status" "Status" NOT NULL,
    "approvalStatus" "CarApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvalNotes" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Car_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT,
    "phoneNumber" TEXT,
    "address" TEXT,
    "city" TEXT,
    "hasOnboarded" BOOLEAN NOT NULL DEFAULT false,
    "bankDetailsId" TEXT,
    "fleetOwnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fleetOwnerStatus" "FleetOwnerStatus" DEFAULT 'PROCESSING',
    "chauffeurApprovalStatus" "ChauffeurApprovalStatus" DEFAULT 'PENDING',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "bookingReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "type" "BookingType" NOT NULL DEFAULT 'DAY',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paymentId" TEXT,
    "paymentIntent" TEXT,
    "netTotal" DECIMAL(10,2),
    "platformCustomerServiceFeeRatePercent" DECIMAL(5,2),
    "platformCustomerServiceFeeAmount" DECIMAL(10,2),
    "subtotalBeforeVat" DECIMAL(10,2),
    "vatRatePercent" DECIMAL(5,2),
    "vatAmount" DECIMAL(10,2),
    "platformFleetOwnerCommissionRatePercent" DECIMAL(5,2),
    "platformFleetOwnerCommissionAmount" DECIMAL(10,2),
    "fleetOwnerPayoutAmountNet" DECIMAL(10,2),
    "overallPayoutStatus" "PayoutTransactionStatus",
    "carId" TEXT NOT NULL,
    "userId" TEXT,
    "guestUser" JSONB,
    "pickupLocation" TEXT NOT NULL,
    "returnLocation" TEXT NOT NULL,
    "specialRequests" TEXT,
    "chauffeurId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingLeg" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "legDate" DATE NOT NULL,
    "legStartTime" TIMESTAMP(3) NOT NULL,
    "legEndTime" TIMESTAMP(3) NOT NULL,
    "itemsNetValueForLeg" DECIMAL(10,2) NOT NULL,
    "platformCommissionRateOnLeg" DECIMAL(5,2),
    "platformCommissionAmountOnLeg" DECIMAL(10,2),
    "fleetOwnerEarningForLeg" DECIMAL(10,2) NOT NULL,
    "totalDailyPrice" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "eventType" "ExtensionEventType" NOT NULL,
    "bookingLegId" TEXT NOT NULL,
    "extensionStartTime" TIMESTAMP(3) NOT NULL,
    "extensionEndTime" TIMESTAMP(3) NOT NULL,
    "extendedDurationHours" INTEGER NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paymentId" TEXT,
    "paymentIntent" TEXT,
    "netTotal" DECIMAL(10,2),
    "platformCustomerServiceFeeRatePercent" DECIMAL(5,2),
    "platformCustomerServiceFeeAmount" DECIMAL(10,2),
    "subtotalBeforeVat" DECIMAL(10,2),
    "vatRatePercent" DECIMAL(5,2),
    "vatAmount" DECIMAL(10,2),
    "platformFleetOwnerCommissionRatePercent" DECIMAL(5,2),
    "platformFleetOwnerCommissionAmount" DECIMAL(10,2),
    "fleetOwnerPayoutAmountNet" DECIMAL(10,2),
    "overallPayoutStatus" "PayoutTransactionStatus",
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "extensionId" TEXT,
    "txRef" TEXT NOT NULL,
    "flutterwaveTransactionId" TEXT,
    "flutterwaveReference" TEXT,
    "amountExpected" DECIMAL(10,2) NOT NULL,
    "amountCharged" DECIMAL(10,2),
    "currency" TEXT NOT NULL,
    "feeChargedByProvider" DECIMAL(10,2),
    "status" "PaymentAttemptStatus" NOT NULL,
    "paymentProviderStatus" TEXT,
    "paymentMethod" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "webhookPayload" JSONB,
    "verificationResponse" JSONB,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutTransaction" (
    "id" TEXT NOT NULL,
    "fleetOwnerId" TEXT NOT NULL,
    "bookingId" TEXT,
    "extensionId" TEXT,
    "amountToPay" DECIMAL(10,2) NOT NULL,
    "amountPaid" DECIMAL(10,2),
    "currency" TEXT NOT NULL,
    "status" "PayoutTransactionStatus" NOT NULL,
    "payoutProviderReference" TEXT,
    "payoutMethodDetails" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "PayoutTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentApproval" (
    "id" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "documentUrl" TEXT NOT NULL,
    "notes" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "userId" TEXT,
    "carId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleImage" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "carId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "effectiveSince" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "description" TEXT DEFAULT 'Nigerian VAT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformFeeRate" (
    "id" TEXT NOT NULL,
    "feeType" "PlatformFeeType" NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "effectiveSince" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformFeeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankDetails" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" TIMESTAMP(3),
    "verificationResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_RoleToUser" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RoleToUser_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PermissionToRole" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PermissionToRole_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Car_ownerId_idx" ON "Car"("ownerId");

-- CreateIndex
CREATE INDEX "Car_ownerId_updatedAt_idx" ON "Car"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "Car_ownerId_approvalStatus_idx" ON "Car"("ownerId", "approvalStatus");

-- CreateIndex
CREATE INDEX "Car_approvalStatus_idx" ON "Car"("approvalStatus");

-- CreateIndex
CREATE INDEX "Car_status_idx" ON "Car"("status");

-- CreateIndex
CREATE INDEX "Car_updatedAt_dayRate_idx" ON "Car"("updatedAt" DESC, "dayRate" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_fleetOwnerId_idx" ON "User"("fleetOwnerId");

-- CreateIndex
CREATE INDEX "User_fleetOwnerStatus_hasOnboarded_idx" ON "User"("fleetOwnerStatus", "hasOnboarded");

-- CreateIndex
CREATE INDEX "User_hasOnboarded_idx" ON "User"("hasOnboarded");

-- CreateIndex
CREATE INDEX "User_id_email_idx" ON "User"("id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_action_entity_access_key" ON "Permission"("action", "entity", "access");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_bookingReference_key" ON "Booking"("bookingReference");

-- CreateIndex
CREATE INDEX "Booking_bookingReference_idx" ON "Booking"("bookingReference");

-- CreateIndex
CREATE INDEX "Booking_carId_idx" ON "Booking"("carId");

-- CreateIndex
CREATE INDEX "Booking_userId_idx" ON "Booking"("userId");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE INDEX "Booking_chauffeurId_idx" ON "Booking"("chauffeurId");

-- CreateIndex
CREATE INDEX "Booking_paymentStatus_idx" ON "Booking"("paymentStatus");

-- CreateIndex
CREATE INDEX "Booking_paymentIntent_idx" ON "Booking"("paymentIntent");

-- CreateIndex
CREATE INDEX "Booking_overallPayoutStatus_idx" ON "Booking"("overallPayoutStatus");

-- CreateIndex
CREATE INDEX "Booking_startDate_endDate_status_idx" ON "Booking"("startDate", "endDate", "status");

-- CreateIndex
CREATE INDEX "Booking_chauffeurId_status_startDate_endDate_idx" ON "Booking"("chauffeurId", "status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Booking_carId_paymentStatus_status_startDate_endDate_idx" ON "Booking"("carId", "paymentStatus", "status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Booking_type_endDate_idx" ON "Booking"("type", "endDate");

-- CreateIndex
CREATE INDEX "BookingLeg_bookingId_idx" ON "BookingLeg"("bookingId");

-- CreateIndex
CREATE INDEX "BookingLeg_legDate_idx" ON "BookingLeg"("legDate");

-- CreateIndex
CREATE UNIQUE INDEX "BookingLeg_bookingId_legDate_key" ON "BookingLeg"("bookingId", "legDate");

-- CreateIndex
CREATE INDEX "Extension_bookingLegId_idx" ON "Extension"("bookingLegId");

-- CreateIndex
CREATE INDEX "Extension_paymentStatus_idx" ON "Extension"("paymentStatus");

-- CreateIndex
CREATE INDEX "Extension_eventType_idx" ON "Extension"("eventType");

-- CreateIndex
CREATE INDEX "Extension_status_idx" ON "Extension"("status");

-- CreateIndex
CREATE INDEX "Extension_overallPayoutStatus_idx" ON "Extension"("overallPayoutStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_txRef_key" ON "Payment"("txRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_flutterwaveTransactionId_key" ON "Payment"("flutterwaveTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_flutterwaveReference_key" ON "Payment"("flutterwaveReference");

-- CreateIndex
CREATE INDEX "Payment_bookingId_idx" ON "Payment"("bookingId");

-- CreateIndex
CREATE INDEX "Payment_extensionId_idx" ON "Payment"("extensionId");

-- CreateIndex
CREATE INDEX "Payment_txRef_idx" ON "Payment"("txRef");

-- CreateIndex
CREATE INDEX "Payment_flutterwaveTransactionId_idx" ON "Payment"("flutterwaveTransactionId");

-- CreateIndex
CREATE INDEX "Payment_flutterwaveReference_idx" ON "Payment"("flutterwaveReference");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "PayoutTransaction_fleetOwnerId_idx" ON "PayoutTransaction"("fleetOwnerId");

-- CreateIndex
CREATE INDEX "PayoutTransaction_status_idx" ON "PayoutTransaction"("status");

-- CreateIndex
CREATE INDEX "PayoutTransaction_bookingId_idx" ON "PayoutTransaction"("bookingId");

-- CreateIndex
CREATE INDEX "PayoutTransaction_extensionId_idx" ON "PayoutTransaction"("extensionId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutTransaction_bookingId_key" ON "PayoutTransaction"("bookingId");

-- CreateIndex
CREATE INDEX "DocumentApproval_status_idx" ON "DocumentApproval"("status");

-- CreateIndex
CREATE INDEX "DocumentApproval_documentType_idx" ON "DocumentApproval"("documentType");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentApproval_documentType_userId_key" ON "DocumentApproval"("documentType", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentApproval_documentType_carId_key" ON "DocumentApproval"("documentType", "carId");

-- CreateIndex
CREATE INDEX "VehicleImage_carId_idx" ON "VehicleImage"("carId");

-- CreateIndex
CREATE INDEX "VehicleImage_status_idx" ON "VehicleImage"("status");

-- CreateIndex
CREATE INDEX "TaxRate_effectiveSince_effectiveUntil_idx" ON "TaxRate"("effectiveSince", "effectiveUntil");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_effectiveSince_key" ON "TaxRate"("effectiveSince");

-- CreateIndex
CREATE INDEX "PlatformFeeRate_feeType_effectiveSince_effectiveUntil_idx" ON "PlatformFeeRate"("feeType", "effectiveSince", "effectiveUntil");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformFeeRate_feeType_effectiveSince_key" ON "PlatformFeeRate"("feeType", "effectiveSince");

-- CreateIndex
CREATE UNIQUE INDEX "BankDetails_userId_key" ON "BankDetails"("userId");

-- CreateIndex
CREATE INDEX "_RoleToUser_B_index" ON "_RoleToUser"("B");

-- CreateIndex
CREATE INDEX "_PermissionToRole_B_index" ON "_PermissionToRole"("B");

-- AddForeignKey
ALTER TABLE "Car" ADD CONSTRAINT "Car_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_fleetOwnerId_fkey" FOREIGN KEY ("fleetOwnerId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_chauffeurId_fkey" FOREIGN KEY ("chauffeurId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingLeg" ADD CONSTRAINT "BookingLeg_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_bookingLegId_fkey" FOREIGN KEY ("bookingLegId") REFERENCES "BookingLeg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTransaction" ADD CONSTRAINT "PayoutTransaction_fleetOwnerId_fkey" FOREIGN KEY ("fleetOwnerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTransaction" ADD CONSTRAINT "PayoutTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTransaction" ADD CONSTRAINT "PayoutTransaction_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentApproval" ADD CONSTRAINT "DocumentApproval_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleImage" ADD CONSTRAINT "VehicleImage_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleImage" ADD CONSTRAINT "VehicleImage_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDetails" ADD CONSTRAINT "BankDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoleToUser" ADD CONSTRAINT "_RoleToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoleToUser" ADD CONSTRAINT "_RoleToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PermissionToRole" ADD CONSTRAINT "_PermissionToRole_A_fkey" FOREIGN KEY ("A") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PermissionToRole" ADD CONSTRAINT "_PermissionToRole_B_fkey" FOREIGN KEY ("B") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
